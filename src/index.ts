import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { YoutubeTranscript } from "./server";
import { AuthkitHandler } from "./authkit-handler";
import { handleApiKeyRequest } from "./api-key-handler";
import type { Env } from "./types";

// Export Durable Objects for Cloudflare Workers
export { YoutubeTranscript };        // MCP Agent for protocol handling
export { ApifySemaphore } from "./apify-semaphore";  // CRITICAL: Concurrency control
export { TranscriptProcessingWorkflow } from "./workflows/transcript-processing-workflow";  // Multi-step AI processing

/**
 * Skeleton MCP Server with Dual Authentication Support
 *
 * This MCP server supports TWO authentication methods:
 *
 * 1. OAuth 2.1 (WorkOS AuthKit) - For OAuth-capable clients
 *    - Flow: Client → /authorize → WorkOS → Magic Auth → /callback → Tools
 *    - Used by: Claude Desktop, ChatGPT, OAuth-capable clients
 *    - Endpoints: /authorize, /callback, /token, /register
 *
 * 2. API Key Authentication - For non-OAuth clients
 *    - Flow: Client sends Authorization: Bearer wtyk_XXX → Validate → Tools
 *    - Used by: AnythingLLM, Cursor IDE, custom scripts
 *    - Endpoints: /sse, /mcp (with wtyk_ API key in header)
 *
 * MCP Endpoints (support both auth methods):
 * - /sse - Server-Sent Events transport (for AnythingLLM, Claude Desktop)
 * - /mcp - Streamable HTTP transport (for ChatGPT and modern clients)
 *
 * OAuth Endpoints (OAuth only):
 * - /authorize - Initiates OAuth flow, redirects to WorkOS AuthKit
 * - /callback - Handles OAuth callback from WorkOS
 * - /token - Token endpoint for OAuth clients
 * - /register - Dynamic Client Registration endpoint
 *
 * Available Tools (after authentication):
 * - simpleLookup: Low-cost operation (1 token)
 * - searchAndAnalyze: Consolidated multi-step operation (2 tokens)
 *
 * TODO: Update tool descriptions above to match your actual tools
 */

// Create OAuthProvider instance (used when OAuth authentication is needed)
const oauthProvider = new OAuthProvider({
    // Dual transport support (SSE + Streamable HTTP)
    // This ensures compatibility with all MCP clients (Claude, ChatGPT, etc.)
    apiHandlers: {
        '/sse': YoutubeTranscript.serveSSE('/sse'),  // Legacy SSE transport
        '/mcp': YoutubeTranscript.serve('/mcp'),     // New Streamable HTTP transport
    },

    // OAuth authentication handler (WorkOS AuthKit integration)
    defaultHandler: AuthkitHandler as any,

    // OAuth 2.1 endpoints
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});

/**
 * Custom fetch handler with dual authentication support
 *
 * This handler detects the authentication method and routes requests accordingly:
 * - API key (wtyk_*) → Direct API key authentication
 * - OAuth token or no auth → OAuth flow via OAuthProvider
 * - /r2/transcripts/* → Public R2 file serving
 */
export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
    ): Promise<Response> {
        try {
            const url = new URL(request.url);
            const authHeader = request.headers.get("Authorization");

            // Handle R2 transcript file requests (public access)
            if (url.pathname.startsWith('/r2/transcripts/')) {
                console.log(`📁 [R2] Serving transcript file: ${url.pathname}`);
                return await handleR2Request(request, env, url.pathname);
            }

            // Check for API key authentication on MCP endpoints
            if (isApiKeyRequest(url.pathname, authHeader)) {
                console.log(`🔐 [Dual Auth] API key request detected: ${url.pathname}`);
                return await handleApiKeyRequest(request, env, ctx, url.pathname);
            }

            // Otherwise, use OAuth flow
            console.log(`🔐 [Dual Auth] OAuth request: ${url.pathname}`);
            return await oauthProvider.fetch(request, env, ctx);

        } catch (error) {
            console.error("[Dual Auth] Error:", error);
            return new Response(
                JSON.stringify({
                    error: "Internal server error",
                    message: error instanceof Error ? error.message : String(error),
                }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }
    },
};

/**
 * Detect if request should use API key authentication
 *
 * Criteria:
 * 1. Must be an MCP endpoint (/sse or /mcp)
 * 2. Must have Authorization header with API key (starts with wtyk_)
 *
 * OAuth endpoints (/authorize, /callback, /token, /register) are NEVER intercepted.
 *
 * @param pathname - Request pathname
 * @param authHeader - Authorization header value
 * @returns true if API key request, false otherwise
 */
function isApiKeyRequest(pathname: string, authHeader: string | null): boolean {
    // Only intercept MCP transport endpoints
    if (pathname !== "/sse" && pathname !== "/mcp") {
        return false;
    }

    // Check if Authorization header contains API key
    if (!authHeader) {
        return false;
    }

    const token = authHeader.replace("Bearer ", "");
    return token.startsWith("wtyk_");
}

/**
 * Handle R2 transcript file requests
 *
 * Serves transcript files from the R2_TRANSCRIPTS bucket with public access.
 * URL format: /r2/transcripts/{videoId}.txt
 *
 * Files are automatically cleaned up after 24 hours via R2 lifecycle rule.
 *
 * @param request - Incoming HTTP request
 * @param env - Cloudflare Workers environment
 * @param pathname - Request pathname (e.g., /r2/transcripts/dQw4w9WgXcQ.txt)
 * @returns Response with transcript file or 404 error
 */
async function handleR2Request(
    request: Request,
    env: Env,
    pathname: string
): Promise<Response> {
    try {
        // Extract key from pathname: /r2/transcripts/{videoId}.txt → transcripts/{videoId}.txt
        const key = pathname.replace(/^\/r2\//, '');

        console.log(`📁 [R2] Fetching file: ${key}`);

        // Fetch file from R2 bucket
        const object = await env.R2_TRANSCRIPTS.get(key);

        if (!object) {
            console.log(`❌ [R2] File not found: ${key}`);
            return new Response('Transcript not found or expired (24h TTL)', {
                status: 404,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }

        console.log(`✅ [R2] Serving file: ${key} (${object.size} bytes)`);

        // Return file with appropriate headers
        return new Response(object.body, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': object.size.toString(),
                'Cache-Control': 'public, max-age=3600',  // Cache for 1 hour
                'X-Video-ID': object.customMetadata?.videoId || 'unknown',
                'X-Uploaded-At': object.customMetadata?.uploadedAt || 'unknown'
            }
        });

    } catch (error) {
        console.error(`❌ [R2] Error serving file:`, error);
        return new Response(
            `Error serving transcript: ${error instanceof Error ? error.message : String(error)}`,
            {
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            }
        );
    }
}
