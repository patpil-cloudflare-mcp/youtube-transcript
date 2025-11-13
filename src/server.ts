import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient } from "./api-client";
import type { Env } from "./types";
import { ResponseFormat } from "./types";
import type { Props } from "./props";
import { checkBalance, consumeTokensWithRetry } from "./tokenConsumption";
import { formatInsufficientTokensError } from "./tokenUtils";
import { sanitizeOutput, redactPII, validateOutput } from 'pilpat-mcp-security';

/**
 * TODO: Rename this class to match your server name (e.g., WeatherMCP, NewsMCP, etc.)
 *
 * Skeleton MCP Server with Token Integration
 *
 * This server demonstrates the complete token-based authentication pattern
 * with three example tools showing different token costs (1, 2, 3 tokens).
 *
 * Generic type parameters:
 * - Env: Cloudflare Workers environment bindings (KV, D1, WorkOS credentials, etc.)
 * - unknown: No state management (stateless server) - change if you need state
 * - Props: Authenticated user context from WorkOS (user, tokens, permissions, userId)
 *
 * Authentication flow:
 * 1. User connects via MCP client
 * 2. Redirected to WorkOS AuthKit (Magic Auth)
 * 3. User enters email → receives 6-digit code
 * 4. OAuth callback checks if user exists in token database
 * 5. If not in database → 403 error page
 * 6. If in database → Access granted, user info available via this.props
 * 7. All tools check token balance before execution
 */
export class YoutubeTranscript extends McpAgent<Env, unknown, Props> {
    server = new McpServer({
        name: "Skeleton MCP Server", // TODO: Update server name
        version: "1.0.0",
    });

    // NO initialState - this is a stateless server
    // TODO: If you need state, add:
    // initialState = { yourStateHere: "value" };
    // Then change generic from 'unknown' to your State type

    async init() {
        // ========================================================================
        // API CLIENT INITIALIZATION
        // ========================================================================
        // TODO: Initialize your custom API client here when implementing tools
        // Example: const apiClient = new YourApiClient(this.env.YOUR_API_KEY);
        // DO NOT uncomment until you have implemented your custom API client class

        // ========================================================================
        // TOOL REGISTRATION SECTION
        // ========================================================================
        // Tools will be generated here by the automated boilerplate generator
        // Usage: npm run generate-tool --prp PRPs/your-prp.md --tool-id your_tool --output snippets
        //
        // Or implement tools manually following the 7-Step Token Pattern:
        // Step 0: Generate actionId for idempotency
        // Step 1: Get userId from this.props
        // Step 2: Check token balance with checkBalance()
        // Step 3: Handle insufficient balance
        // Step 4: Execute business logic
        // Step 4.5: Apply security (sanitizeOutput + redactPII)
        // Step 5: Consume tokens with consumeTokensWithRetry()
        // Step 6: Return result
        //
        // Tool Design Best Practices:
        // ✅ Consolidation: Combine multi-step operations into goal-oriented tools
        // ✅ ResponseFormat: Add format parameter for large datasets (concise/detailed)
        // ✅ Context Optimization: Return semantic data (names) not technical (IDs)
        // ✅ Token Efficiency: Implement pagination, filtering, smart defaults
        // ✅ Single-Item Inputs: Accept one item per call to enable deep AI analysis
        //    - Use: pageUrl: z.string().url() (Analyst mode - deep insights)
        //    - NOT: pageUrls: z.array(z.string()) (Aggregator mode - shallow lists)
        //    - Rationale: Array inputs flood LLM context → forces shallow aggregation
        //    - Exception: Batch export tools where aggregation IS the goal
        //
        // TODO: Add your tools here (manually or via generator)
    }
}
