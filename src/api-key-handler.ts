/**
 * API Key Authentication Handler for Skeleton MCP Server
 *
 * This module provides API key authentication support for MCP clients that don't support
 * OAuth flows (like AnythingLLM, Cursor IDE, custom scripts).
 *
 * Authentication flow:
 * 1. Extract API key from Authorization header
 * 2. Validate key using validateApiKey()
 * 3. Get user from database
 * 4. Create MCP server with tools
 * 5. Handle MCP protocol request
 * 6. Return response
 *
 * TODO: When you add new tools to server.ts, you MUST also:
 * 1. Register them in getOrCreateServer() (around line 260)
 * 2. Add tool executor functions (around line 770)
 * 3. Add cases to handleToolsCall() (around line 750)
 * 4. Add tool schemas to handleToolsList() (around line 625)
 */

import { validateApiKey } from "./apiKeys";
import { getUserById } from "./tokenUtils";
import type { Env, ResponseFormat, SemaphoreSlot } from "./types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient } from "./api-client";
import { checkBalance, consumeTokensWithRetry } from "./tokenConsumption";
import { formatInsufficientTokensError, formatAccountDeletedError } from "./tokenUtils";
import { sanitizeOutput, redactPII, validateOutput } from 'pilpat-mcp-security';
import { ApifyClient } from './apify-client';
import { extractYouTubeVideoId, formatTranscriptAsText } from './utils/youtube';
import { getCachedApifyResult, setCachedApifyResult, hashApifyInput } from './apify-cache';

/**
 * Simple LRU (Least Recently Used) Cache for MCP Server instances
 *
 * IMPORTANT: This cache is ephemeral and Worker-instance-specific:
 *
 * 🔸 **Ephemeral (Non-Persistent):**
 *   - Cache is cleared when the Worker is evicted from memory
 *   - Eviction can happen at any time (deployments, inactivity, memory pressure)
 *   - NO guarantee of cache persistence between requests
 *
 * 🔸 **Worker-Instance-Specific:**
 *   - Different Worker instances (different data centers) have separate caches
 *   - A user in Warsaw and a user in New York access different caches
 *   - Cache is NOT replicated globally (unlike D1 database)
 *
 * 🔸 **Performance Optimization Only:**
 *   - This is a PERFORMANCE optimization, not critical state storage
 *   - Cache misses simply recreate the MCP server (acceptable overhead)
 *   - Critical state (balances, tokens, transactions) is stored in D1 database
 *
 * 🔸 **Why This Is Safe:**
 *   - MCP servers are stateless (tools query database on each call)
 *   - Recreating a server doesn't cause data loss or corruption
 *   - Token consumption is atomic via D1 transactions (not cached)
 *   - User balances are ALWAYS queried from database (never cached)
 *
 * 🔸 **LRU Eviction:**
 *   - When cache reaches MAX_SIZE, the least recently used server is evicted
 *   - This prevents unbounded memory growth
 *   - Evicted servers are simply garbage collected
 *
 * Reference: Cloudflare Docs - "In-memory state in Durable Objects"
 * https://developers.cloudflare.com/durable-objects/reference/in-memory-state/
 */
class LRUCache<K, V> {
  private cache: Map<K, { value: V; lastAccessed: number }>;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Get value from cache and update last accessed time
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Update last accessed time (LRU tracking)
      entry.lastAccessed = Date.now();
      return entry.value;
    }
    return undefined;
  }

  /**
   * Set value in cache with automatic LRU eviction
   */
  set(key: K, value: V): void {
    // If cache is full, evict least recently used entry
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      value,
      lastAccessed: Date.now(),
    });
  }

  /**
   * Check if key exists in cache
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Evict least recently used entry from cache
   */
  private evictLRU(): void {
    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    // Find least recently used entry
    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
      console.log(`🗑️  [LRU Cache] Evicted server for user: ${String(oldestKey)}`);
    }
  }

  /**
   * Clear entire cache (useful for testing)
   */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Global MCP server cache
 *
 * Configuration:
 * - Max size: 1000 servers (prevents unbounded memory growth)
 * - Eviction policy: LRU (Least Recently Used)
 * - Lifetime: Until Worker is evicted from memory
 *
 * Typical memory usage:
 * - Each MCP server: ~50-100 KB
 * - 1000 servers: ~50-100 MB (acceptable for Workers)
 *
 * Workers have 128 MB memory limit, so 1000 servers leaves plenty of headroom.
 */
const MAX_CACHED_SERVERS = 1000;
const serverCache = new LRUCache<string, McpServer>(MAX_CACHED_SERVERS);

/**
 * Main entry point for API key authenticated MCP requests
 *
 * @param request - Incoming HTTP request
 * @param env - Cloudflare Workers environment
 * @param ctx - Execution context
 * @param pathname - Request pathname (/sse or /mcp)
 * @returns MCP protocol response
 */
export async function handleApiKeyRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  pathname: string
): Promise<Response> {
  try {
    console.log(`🔐 [API Key Auth] Request to ${pathname}`);

    // 1. Extract API key from Authorization header
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace("Bearer ", "");

    if (!apiKey) {
      console.log("❌ [API Key Auth] Missing Authorization header");
      return jsonError("Missing Authorization header", 401);
    }

    // 2. Validate API key and get user_id
    const userId = await validateApiKey(apiKey, env);

    if (!userId) {
      console.log("❌ [API Key Auth] Invalid or expired API key");
      return jsonError("Invalid or expired API key", 401);
    }

    // 3. Get user from database
    const dbUser = await getUserById(env.TOKEN_DB, userId);

    if (!dbUser) {
      // getUserById already checks is_deleted, so null means not found OR deleted
      console.log(`❌ [API Key Auth] User not found or deleted: ${userId}`);
      return jsonError("User not found or account deleted", 404);
    }

    console.log(
      `✅ [API Key Auth] Authenticated user: ${dbUser.email} (${userId}), balance: ${dbUser.current_token_balance} tokens`
    );

    // 4. Create or get cached MCP server with tools
    const server = await getOrCreateServer(env, userId, dbUser.email);

    // 5. Handle the MCP request using the appropriate transport
    if (pathname === "/sse") {
      return await handleSSETransport(server, request);
    } else if (pathname === "/mcp") {
      return await handleHTTPTransport(server, request, env, userId, dbUser.email);
    } else {
      return jsonError("Invalid endpoint. Use /sse or /mcp", 400);
    }
  } catch (error) {
    console.error("[API Key Auth] Error:", error);
    return jsonError(
      `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
      500
    );
  }
}

/**
 * Get or create MCP server instance for API key user
 *
 * This creates a standalone MCP server (not using McpAgent) with all tools.
 * The server instance is cached per user to avoid recreating it on every request.
 *
 * Cache behavior:
 * - Cache hit: Returns existing server immediately (~1ms)
 * - Cache miss: Creates new server (~10-50ms), then caches it
 * - Cache full: Evicts least recently used server automatically
 *
 * TODO: When you add new tools to server.ts, you MUST add them here too!
 *
 * @param env - Cloudflare Workers environment
 * @param userId - User ID for token management
 * @param email - User email for logging
 * @returns Configured MCP server instance
 */
async function getOrCreateServer(
  env: Env,
  userId: string,
  email: string
): Promise<McpServer> {
  // Check cache first
  const cached = serverCache.get(userId);
  if (cached) {
    console.log(
      `📦 [LRU Cache] HIT for user ${userId} (cache size: ${serverCache.size}/${MAX_CACHED_SERVERS})`
    );
    return cached;
  }

  console.log(
    `🔧 [LRU Cache] MISS for user ${userId} - creating new server (cache size: ${serverCache.size}/${MAX_CACHED_SERVERS})`
  );

  // Create new MCP server
  const server = new McpServer({
    name: "YouTube Transcript MCP (API Key)",
    version: "1.0.0",
  });

  // ========================================================================
  // LOCATION 1: TOOL REGISTRATION SECTION
  // ========================================================================

  // TOOL: get_youtube_transcript
  server.tool(
    "get_youtube_transcript",
    "Extract full transcript from a YouTube video with timestamps. Returns formatted text with [HH:MM:SS] timestamps. ⚠️ Costs 3 tokens per request. Zero cost if no transcript.",
    {
      videoUrl: z.string().url("Invalid YouTube URL").describe("YouTube video URL (e.g., 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')")
    },
    async (params) => {
      return await executeGetYoutubeTranscriptTool(params, env, userId);
    }
  );

  // TOOL: get_annotated_summary
  server.tool(
    "get_annotated_summary",
    "Get AI-generated summary of YouTube video with timestamped chapters. Uses Workers AI for cleaning and summarization. ⚠️ Costs 5 tokens (3 for transcript + 2 for AI processing). Zero cost if no transcript.",
    {
      videoUrl: z.string().url("Invalid YouTube URL").describe("YouTube video URL (e.g., 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')")
    },
    async (params) => {
      return await executeGetAnnotatedSummaryTool(params, env, userId);
    }
  );

  // Cache the server (automatic LRU eviction if cache is full)
  serverCache.set(userId, server);

  console.log(
    `✅ [LRU Cache] Server created and cached for user ${userId} (cache size: ${serverCache.size}/${MAX_CACHED_SERVERS})`
  );
  return server;
}

/**
 * Handle HTTP (Streamable HTTP) transport for MCP protocol
 *
 * Streamable HTTP is the modern MCP transport protocol that replaced SSE.
 * It uses standard HTTP POST requests with JSON-RPC 2.0 protocol.
 *
 * Supported JSON-RPC methods:
 * - initialize: Protocol handshake and capability negotiation
 * - ping: Health check (required by AnythingLLM)
 * - tools/list: List all available tools
 * - tools/call: Execute a specific tool
 *
 * @param server - Configured MCP server instance
 * @param request - Incoming HTTP POST request with JSON-RPC message
 * @param env - Cloudflare Workers environment
 * @param userId - User ID for logging
 * @param userEmail - User email for logging
 * @returns JSON-RPC response
 */
async function handleHTTPTransport(
  server: McpServer,
  request: Request,
  env: Env,
  userId: string,
  userEmail: string
): Promise<Response> {
  console.log(`📡 [API Key Auth] HTTP transport request from ${userEmail}`);

  try {
    // Parse JSON-RPC request
    const jsonRpcRequest = await request.json() as {
      jsonrpc: string;
      id: number | string;
      method: string;
      params?: any;
    };

    console.log(`📨 [HTTP] Method: ${jsonRpcRequest.method}, ID: ${jsonRpcRequest.id}`);

    // Validate JSON-RPC 2.0 format
    if (jsonRpcRequest.jsonrpc !== "2.0") {
      return jsonRpcResponse(jsonRpcRequest.id, null, {
        code: -32600,
        message: "Invalid Request: jsonrpc must be '2.0'",
      });
    }

    // Route to appropriate handler based on method
    switch (jsonRpcRequest.method) {
      case "initialize":
        return handleInitialize(jsonRpcRequest);

      case "ping":
        return handlePing(jsonRpcRequest);

      case "tools/list":
        return await handleToolsList(server, jsonRpcRequest);

      case "tools/call":
        return await handleToolsCall(server, jsonRpcRequest, env, userId, userEmail);

      default:
        return jsonRpcResponse(jsonRpcRequest.id, null, {
          code: -32601,
          message: `Method not found: ${jsonRpcRequest.method}`,
        });
    }
  } catch (error) {
    console.error("❌ [HTTP] Error:", error);
    return jsonRpcResponse("error", null, {
      code: -32700,
      message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Handle initialize request (MCP protocol handshake)
 */
function handleInitialize(request: {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: any;
}): Response {
  console.log("✅ [HTTP] Initialize request");

  return jsonRpcResponse(request.id, {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "Skeleton MCP Server", // TODO: Update server name
      version: "1.0.0",
    },
  });
}

/**
 * Handle ping request (health check)
 */
function handlePing(request: {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: any;
}): Response {
  console.log("✅ [HTTP] Ping request");

  return jsonRpcResponse(request.id, {});
}

/**
 * Handle tools/list request (list all available tools)
 *
 * TODO: When you add new tools, update this list to match!
 */
async function handleToolsList(
  server: McpServer,
  request: {
    jsonrpc: string;
    id: number | string;
    method: string;
    params?: any;
  }
): Promise<Response> {
  console.log("✅ [HTTP] Tools list request");

  // ========================================================================
  // LOCATION 2: TOOL SCHEMA DEFINITIONS
  // ========================================================================

  const tools: any[] = [
    {
      name: "get_youtube_transcript",
      description: "Extract full transcript from a YouTube video with timestamps. Returns formatted text with [HH:MM:SS] timestamps. ⚠️ Costs 3 tokens per request. Zero cost if no transcript.",
      inputSchema: {
        type: "object",
        properties: {
          videoUrl: {
            type: "string",
            format: "uri",
            description: "YouTube video URL (e.g., 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')"
          }
        },
        required: ["videoUrl"]
      }
    },
    {
      name: "get_annotated_summary",
      description: "Get AI-generated summary of YouTube video with timestamped chapters. Uses Workers AI for cleaning and summarization. ⚠️ Costs 5 tokens (3 for transcript + 2 for AI processing). Zero cost if no transcript.",
      inputSchema: {
        type: "object",
        properties: {
          videoUrl: {
            type: "string",
            format: "uri",
            description: "YouTube video URL (e.g., 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')"
          }
        },
        required: ["videoUrl"]
      }
    }
  ];

  return jsonRpcResponse(request.id, {
    tools,
  });
}

/**
 * Handle tools/call request (execute a tool)
 *
 * TODO: When you add new tools, add cases to the switch statement!
 */
async function handleToolsCall(
  server: McpServer,
  request: {
    jsonrpc: string;
    id: number | string;
    method: string;
    params?: {
      name: string;
      arguments?: Record<string, any>;
    };
  },
  env: Env,
  userId: string,
  userEmail: string
): Promise<Response> {
  if (!request.params || !request.params.name) {
    return jsonRpcResponse(request.id, null, {
      code: -32602,
      message: "Invalid params: name is required",
    });
  }

  const toolName = request.params.name;
  const toolArgs = request.params.arguments || {};

  console.log(`🔧 [HTTP] Tool call: ${toolName} by ${userEmail}`, toolArgs);

  try {
    // Execute tool logic based on tool name
    // This duplicates the logic from getOrCreateServer() but is necessary
    // because McpServer doesn't expose a way to call tools directly

    let result: any;

    // ========================================================================
    // LOCATION 3: TOOL SWITCH CASES
    // ========================================================================

    switch (toolName) {
      case "get_youtube_transcript":
        result = await executeGetYoutubeTranscriptTool(toolArgs, env, userId);
        break;

      case "get_annotated_summary":
        result = await executeGetAnnotatedSummaryTool(toolArgs, env, userId);
        break;

      default:
        return jsonRpcResponse(request.id, null, {
          code: -32601,
          message: `Unknown tool: ${toolName}`,
        });
    }

    console.log(`✅ [HTTP] Tool ${toolName} completed successfully`);

    return jsonRpcResponse(request.id, result);
  } catch (error) {
    console.error(`❌ [HTTP] Tool ${toolName} failed:`, error);
    return jsonRpcResponse(request.id, null, {
      code: -32603,
      message: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ==============================================================================
// LOCATION 4: TOOL EXECUTOR FUNCTIONS
// ==============================================================================

/**
 * Execute get_youtube_transcript tool
 * Extracts full transcript from YouTube video with timestamps
 */
async function executeGetYoutubeTranscriptTool(
  args: Record<string, any>,
  env: Env,
  userId: string
): Promise<any> {
  const ACTOR_ID = "faVsWy9VTSNVIhWpR";
  const FLAT_COST = 3;
  const MAX_COST = 3;
  const TOOL_NAME = "get_youtube_transcript";
  const TIMEOUT = 60;
  const CACHE_TTL = 900;
  const actionId = crypto.randomUUID();

  let slot: SemaphoreSlot | null = null;

  try {
    // STEP 1: Validate URL
    const videoId = extractYouTubeVideoId(args.videoUrl);
    if (!videoId) throw new Error("Invalid YouTube URL format");

    // STEP 2: Check balance
    const balanceCheck = await checkBalance(env.TOKEN_DB, userId, MAX_COST);
    if (!balanceCheck.sufficient) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: formatInsufficientTokensError(TOOL_NAME, balanceCheck.currentBalance, MAX_COST)
        }]
      };
    }

    // STEP 3.5: Check cache (BEFORE semaphore!)
    const cacheKey = await hashApifyInput({ actorId: ACTOR_ID, input: { videoUrl: args.videoUrl } });
    const cached = await getCachedApifyResult(env.CACHE_KV, ACTOR_ID, cacheKey);

    if (cached) {
      // Reconstruct missing fields from available data (handles old cached data)
      const videoId = cached.videoId || extractYouTubeVideoId(cached.videoUrl || args.videoUrl);
      const wordCount = cached.wordCount || (cached.transcript ? cached.transcript.split(/\s+/).length : 0);

      await consumeTokensWithRetry(env.TOKEN_DB, userId, FLAT_COST, "youtube-transcript", TOOL_NAME, args, cached, true, actionId);
      const preview = cached.transcript ? cached.transcript.substring(0, 2000) : '';
      return { content: [{ type: "text", text: `✅ Transcript (Cached)\n\nVideo: ${videoId}\nWords: ${wordCount}\n\n${preview}...` }] };
    }

    // STEP 3.7: Acquire semaphore
    const semaphoreId = env.APIFY_SEMAPHORE.idFromName("global");
    const semaphore = env.APIFY_SEMAPHORE.get(semaphoreId) as any;
    slot = await semaphore.acquireSlot(userId, ACTOR_ID);

    // STEP 4: Execute Actor
    const apifyClient = new ApifyClient(env.APIFY_API_TOKEN);
    const actorInput = { videoUrl: args.videoUrl };
    const results = await apifyClient.runActorSync(ACTOR_ID, actorInput, TIMEOUT);

    const transcript = results.items[0] || null;
    if (!transcript || !transcript.data || !Array.isArray(transcript.data) || transcript.data.length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "No transcript available. No tokens charged." }]
      };
    }

    // STEP 4.4-4.5: Format & Security
    const transcriptText = formatTranscriptAsText(transcript);
    const sanitized = sanitizeOutput(transcriptText, { maxLength: 50000, removeHtml: true, removeControlChars: true, normalizeWhitespace: true });
    const { redacted } = redactPII(sanitized, { redactEmails: false, redactPhones: true, redactCreditCards: true });

    // Safety check: Ensure we have valid transcript
    if (!redacted || redacted.trim().length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "Transcript extraction failed - no valid text found. No tokens charged." }]
      };
    }

    const finalResult = {
      videoId,
      videoUrl: args.videoUrl,
      transcript: redacted,
      wordCount: redacted.split(/\s+/).length
    };

    // STEP 4.7: Cache
    await setCachedApifyResult(env.CACHE_KV, ACTOR_ID, cacheKey, finalResult, CACHE_TTL);

    // STEP 5: Consume tokens
    await consumeTokensWithRetry(env.TOKEN_DB, userId, FLAT_COST, "youtube-transcript", TOOL_NAME, args, finalResult, false, actionId);

    // STEP 6: Return
    const preview = finalResult.transcript.substring(0, 2000);
    return {
      content: [{
        type: "text",
        text: `✅ YouTube Transcript\n\nVideo: ${videoId}\nWords: ${finalResult.wordCount}\n\n${preview}...`
      }]
    };

  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }]
    };
  } finally {
    // CRITICAL: Always release semaphore
    if (slot && userId) {
      const semaphoreId = env.APIFY_SEMAPHORE.idFromName("global");
      const semaphore = env.APIFY_SEMAPHORE.get(semaphoreId) as any;
      await semaphore.releaseSlot(userId);
    }
  }
}

/**
 * Execute get_annotated_summary tool
 * Generates AI-powered summary of YouTube video with timestamped chapters
 */
async function executeGetAnnotatedSummaryTool(
  args: Record<string, any>,
  env: Env,
  userId: string
): Promise<any> {
  const ACTOR_ID = "faVsWy9VTSNVIhWpR";
  const FLAT_COST = 5;  // 3 for transcript + 2 for AI processing
  const MAX_COST = 5;
  const TOOL_NAME = "get_annotated_summary";
  const TIMEOUT = 60;
  const CACHE_TTL = 900;
  const actionId = crypto.randomUUID();

  let slot: SemaphoreSlot | null = null;

  try {
    // STEP 1: Validate URL
    const videoId = extractYouTubeVideoId(args.videoUrl);
    if (!videoId) throw new Error("Invalid YouTube URL format");

    // STEP 2: Check balance
    const balanceCheck = await checkBalance(env.TOKEN_DB, userId, MAX_COST);
    if (!balanceCheck.sufficient) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: formatInsufficientTokensError(TOOL_NAME, balanceCheck.currentBalance, MAX_COST)
        }]
      };
    }

    // STEP 3.5: Check cache for transcript
    const cacheKey = await hashApifyInput({ actorId: ACTOR_ID, input: { videoUrl: args.videoUrl } });
    let transcriptData = await getCachedApifyResult(env.CACHE_KV, ACTOR_ID, cacheKey);

    if (!transcriptData) {
      // STEP 3.7: Acquire semaphore
      const semaphoreId = env.APIFY_SEMAPHORE.idFromName("global");
      const semaphore = env.APIFY_SEMAPHORE.get(semaphoreId) as any;
      slot = await semaphore.acquireSlot(userId, ACTOR_ID);

      // STEP 4: Execute Actor
      const apifyClient = new ApifyClient(env.APIFY_API_TOKEN);
      const actorInput = { videoUrl: args.videoUrl };
      const results = await apifyClient.runActorSync(ACTOR_ID, actorInput, TIMEOUT);

      const transcript = results.items[0] || null;
      if (!transcript || !transcript.data || !Array.isArray(transcript.data) || transcript.data.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "No transcript available. No tokens charged." }]
        };
      }

      transcriptData = transcript;

      // STEP 4.7: Cache transcript
      await setCachedApifyResult(env.CACHE_KV, ACTOR_ID, cacheKey, transcriptData, CACHE_TTL);
    }

    // STEP 5: Invoke Cloudflare Workflow for AI processing
    const workflowId = `transcript-${videoId}-${Date.now()}`;
    const instance = await env.TRANSCRIPT_WORKFLOW.create({
        id: workflowId,
        params: {
            videoId,
            transcriptData
        }
    });

    // Wait for workflow to complete (polls every 2 seconds, max 60 seconds)
    let workflowResult: any = null;
    let attempts = 0;
    const maxAttempts = 30; // 60 seconds total

    while (attempts < maxAttempts) {
        const status = await instance.status();

        if (status.status === 'complete') {
            workflowResult = status.output;
            break;
        } else if (status.status === 'errored') {
            throw new Error(`Workflow failed: ${status.error || 'Unknown error'}`);
        }

        // Wait 2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
    }

    if (!workflowResult) {
        throw new Error('Workflow timed out after 60 seconds');
    }

    // STEP 6: Consume tokens
    const finalResult = {
      videoId,
      videoUrl: args.videoUrl,
      summary: workflowResult.summary,
      wordCount: workflowResult.wordCount,
      chapterCount: workflowResult.chapterCount
    };

    await consumeTokensWithRetry(env.TOKEN_DB, userId, FLAT_COST, "youtube-transcript", TOOL_NAME, args, finalResult, false, actionId);

    // STEP 7: Return
    return {
      content: [{
        type: "text",
        text: `📺 **AI-Generated Video Summary**\n\n**Video:** ${videoId}\n**Word Count:** ${finalResult.wordCount}\n**Chapters:** ${finalResult.chapterCount}\n\n---\n\n${finalResult.summary}`
      }]
    };

  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }]
    };
  } finally {
    // CRITICAL: Always release semaphore
    if (slot && userId) {
      const semaphoreId = env.APIFY_SEMAPHORE.idFromName("global");
      const semaphore = env.APIFY_SEMAPHORE.get(semaphoreId) as any;
      await semaphore.releaseSlot(userId);
    }
  }
}

// ==============================================================================
// JSON-RPC & UTILITY FUNCTIONS
// ==============================================================================

/**
 * Create a JSON-RPC 2.0 response
 */
function jsonRpcResponse(
  id: number | string,
  result: any = null,
  error: { code: number; message: string } | null = null
): Response {
  const response: any = {
    jsonrpc: "2.0",
    id,
  };

  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Handle SSE (Server-Sent Events) transport for MCP protocol
 *
 * SSE is used by AnythingLLM and other clients for real-time MCP communication.
 * This uses the standard MCP SDK SSEServerTransport for Cloudflare Workers.
 *
 * @param server - Configured MCP server instance
 * @param request - Incoming HTTP request
 * @returns SSE response stream
 */
async function handleSSETransport(server: McpServer, request: Request): Promise<Response> {
  console.log("📡 [API Key Auth] Setting up SSE transport");

  try {
    // For Cloudflare Workers, we need to return a Response with a ReadableStream
    // The MCP SDK's SSEServerTransport expects Node.js streams, so we'll implement
    // SSE manually for Cloudflare Workers compatibility

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Send SSE headers
    const response = new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });

    // Connect server to client (handle in background)
    // Note: This is a simplified implementation for API key auth
    // Full SSE support would require handling POST messages from client

    (async () => {
      try {
        // Send initial connection event
        await writer.write(encoder.encode("event: message\n"));
        await writer.write(encoder.encode('data: {"status":"connected"}\n\n'));

        console.log("✅ [API Key Auth] SSE connection established");

        // Keep connection alive
        const keepAliveInterval = setInterval(async () => {
          try {
            await writer.write(encoder.encode(": keepalive\n\n"));
          } catch (e) {
            clearInterval(keepAliveInterval);
          }
        }, 30000);

        // Note: Full MCP protocol implementation would go here
        // For MVP, we're providing basic SSE connectivity
      } catch (error) {
        console.error("❌ [API Key Auth] SSE error:", error);
        await writer.close();
      }
    })();

    return response;
  } catch (error) {
    console.error("❌ [API Key Auth] SSE transport error:", error);
    throw error;
  }
}

/**
 * Helper function to return JSON error responses
 *
 * @param message - Error message
 * @param status - HTTP status code
 * @returns JSON error response
 */
function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: message,
      status: status,
    }),
    {
      status: status,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}
