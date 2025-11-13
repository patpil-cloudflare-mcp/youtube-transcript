/**
 * Cloudflare Workers Environment Bindings
 *
 * This interface defines all the bindings available to your MCP server,
 * including authentication credentials and Cloudflare resources.
 *
 * TODO: Add your custom bindings here (AI, R2, additional KV/D1, etc.)
 */
export interface Env {
    /** KV namespace for storing OAuth tokens and session data */
    OAUTH_KV: KVNamespace;

    /** Durable Object namespace for MCP server instances (required by McpAgent) */
    MCP_OBJECT: DurableObjectNamespace;

    /** D1 Database for token management (shared with mcp-token-system) */
    TOKEN_DB: D1Database;

    /** WorkOS Client ID (public, used to initiate OAuth flows) */
    WORKOS_CLIENT_ID: string;

    /** WorkOS API Key (sensitive, starts with sk_, used to initialize WorkOS SDK) */
    WORKOS_API_KEY: string;

    /**
     * KV namespace for centralized custom login session storage (MANDATORY)
     *
     * CRITICAL: This is REQUIRED for centralized authentication at panel.wtyczki.ai
     *
     * Without this binding:
     * - Users will be redirected to default WorkOS UI (exciting-domain-65.authkit.app)
     * - Centralized branded login will NOT work
     * - Session sharing across servers will fail
     *
     * This namespace is already configured in wrangler.jsonc with the correct ID
     * from CLOUDFLARE_CONFIG.md. DO NOT make this optional or remove it.
     *
     * See docs/CUSTOM_LOGIN_GUIDE.md for architecture details.
     */
    USER_SESSIONS: KVNamespace;

    /**
     * Cloudflare AI Gateway Configuration
     *
     * Route all AI requests through AI Gateway for:
     * - Authenticated access control
     * - Rate limiting (60 requests/hour per user)
     * - Response caching (1-hour TTL)
     * - Analytics and monitoring
     */
    AI_GATEWAY_ID: string;
    AI_GATEWAY_TOKEN: string;

    /**
     * APIFY-SPECIFIC BINDINGS (REQUIRED)
     */

    /** CRITICAL: Apify API token for Actor execution (get from https://console.apify.com/account/integrations) */
    APIFY_API_TOKEN: string;

    /** CRITICAL: Durable Object for concurrency control (Fast Fail pattern at 32 concurrent runs) */
    APIFY_SEMAPHORE: DurableObjectNamespace;

    /** KV namespace for caching Apify results (15-minute TTL for hot queries) */
    CACHE_KV: KVNamespace;
}

/**
 * TODO: Define your API response types here
 *
 * Example:
 * export interface ExternalApiResponse {
 *     data: string;
 *     status: number;
 *     timestamp: string;
 * }
 */

/**
 * TODO: Define your tool result types here
 *
 * Example:
 * export interface ProcessedDataResult {
 *     processedData: string[];
 *     count: number;
 *     metadata: Record<string, unknown>;
 * }
 */

/**
 * Response format options for tools that return large datasets
 *
 * Based on MCP best practices for token optimization and LLM comprehension.
 * Use this enum to give agents control over response verbosity.
 *
 * @see https://developers.cloudflare.com/agents/model-context-protocol/
 */
export enum ResponseFormat {
    /**
     * Concise format: Essential data only, ~1/3 tokens
     *
     * - Returns human-readable names, descriptions, and key attributes
     * - Excludes technical IDs, metadata, and redundant fields
     * - Optimized for LLM comprehension and decision-making
     * - Default choice for most tools
     *
     * Example: { name: "Report.pdf", type: "PDF", author: "Jane Smith" }
     */
    CONCISE = "concise",

    /**
     * Detailed format: Full data including IDs for programmatic use
     *
     * - Includes all fields from API response
     * - Contains technical identifiers (UUIDs, IDs, hashes)
     * - Useful when agent needs to make subsequent API calls
     * - Use for tools that are building blocks for complex workflows
     *
     * Example: { id: "uuid-123", name: "Report.pdf", mime_type: "application/pdf", ... }
     */
    DETAILED = "detailed"
}

/**
 * APIFY-SPECIFIC TYPES
 */

/**
 * Apify Actor run status
 */
export type ApifyRunStatus = "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED";

/**
 * Apify Actor run metadata
 */
export interface ApifyActorRun {
    /** Unique run ID */
    id: string;

    /** Current status of the Actor run */
    status: ApifyRunStatus;

    /** ID of the dataset containing results */
    defaultDatasetId: string;

    /** When the run started (ISO 8601) */
    startedAt: string;

    /** When the run finished (ISO 8601), undefined if still running */
    finishedAt?: string;

    /** Run statistics */
    stats: ApifyRunStats;
}

/**
 * Apify Actor run statistics
 */
export interface ApifyRunStats {
    /** Size of input in bytes */
    inputBodyLen: number;

    /** Number of times the Actor was restarted */
    restartCount: number;

    /** Compute units consumed */
    computeUnits: number;

    /** Average memory usage in bytes */
    memoryAvgBytes: number;

    /** Total runtime in milliseconds, undefined if still running */
    durationMillis?: number;
}

/**
 * Apify dataset result
 */
export interface ApifyDatasetResult<T = any> {
    /** Array of result items */
    items: T[];

    /** Total number of items in the dataset */
    count: number;

    /** Maximum number of items per page */
    limit: number;

    /** Offset for pagination */
    offset: number;
}

/**
 * Apify API error
 */
export class ApifyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ApifyError";
    }
}

/**
 * Semaphore slot acquisition result
 *
 * Used by ApifySemaphore Durable Object to control concurrency.
 */
export interface SemaphoreSlot {
    /** Whether a slot was successfully acquired */
    acquired: boolean;

    /** Current number of active slots */
    currentSlots: number;

    /** Maximum allowed slots (32 for Apify Starter plan) */
    maxSlots: number;

    /** Estimated wait time in seconds if slot not acquired */
    estimatedWaitTime?: number;
}
