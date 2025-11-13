/**
 * Apify API Client - Synchronous Actor Execution
 *
 * Simplified client for executing Apify Actors with synchronous flow (<5 minute runs).
 * Optimized for social media scrapers (Twitter, YouTube, LinkedIn) that typically
 * complete within 1-3 minutes.
 *
 * Features:
 * - Synchronous execution with run-sync-get-dataset-items endpoint
 * - Automatic dataset retrieval (no polling needed)
 * - Error handling with ApifyError
 * - TypeScript generics for type-safe results
 *
 * Limitations (MVP):
 * - No async/polling support (add later for >5min runs)
 * - No task execution (Actors only)
 * - No advanced error retry logic
 * - No webhook integration
 *
 * @see https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor
 * @see /Users/patpil/cloudflare_mcp_projects/cloudflare_mcp_apify/apify_docs.md
 */

import type { ApifyActorRun, ApifyDatasetResult } from "./types";
import { ApifyError } from "./types";

/**
 * Apify API Client for synchronous Actor execution
 */
export class ApifyClient {
    private readonly apiToken: string;
    private readonly baseUrl = "https://api.apify.com/v2";

    /**
     * Create Apify client with API token
     *
     * @param apiToken - Apify API token from https://console.apify.com/account/integrations
     */
    constructor(apiToken: string) {
        if (!apiToken || apiToken.trim() === "") {
            throw new ApifyError("Apify API token is required");
        }
        this.apiToken = apiToken;
    }

    /**
     * Run Apify Actor synchronously and return dataset items
     *
     * SYNCHRONOUS FLOW: Connection held for up to 5 minutes (300s).
     * Best for: Social media scrapers, quick web scraping, API wrappers
     *
     * If Actor runs >5min: Falls back to async mode (returns run metadata)
     *
     * @param actorId - Actor ID or name (e.g., "apify/twitter-scraper" or "username~actor-name")
     * @param input - Actor input object (schema varies by Actor)
     * @param timeout - Maximum wait time in seconds (default: 300 = 5 minutes)
     * @returns Dataset items and metadata
     *
     * @example
     * ```typescript
     * const client = new ApifyClient(env.APIFY_API_TOKEN);
     *
     * const result = await client.runActorSync("apify/twitter-scraper", {
     *   handles: ["elonmusk"],
     *   maxTweets: 100
     * });
     *
     * console.log(`Found ${result.items.length} tweets`);
     * ```
     */
    async runActorSync<T = any>(
        actorId: string,
        input: Record<string, any>,
        timeout: number = 300
    ): Promise<{ items: T[]; run: Partial<ApifyActorRun> }> {
        const url = `${this.baseUrl}/acts/${actorId}/run-sync-get-dataset-items?token=${this.apiToken}&timeout=${timeout}`;

        console.log(`[ApifyClient] Running Actor: ${actorId} (timeout: ${timeout}s)`);
        console.log(`[ApifyClient] Input:`, JSON.stringify(input));

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(input)
            });

            if (!response.ok) {
                // Try to extract error details from response body
                let errorMessage = `Actor run failed: ${response.status} ${response.statusText}`;
                try {
                    const errorBody = await response.json() as any;
                    if (errorBody?.error) {
                        errorMessage += ` - ${errorBody.error.message || JSON.stringify(errorBody.error)}`;
                    }
                } catch {
                    // Response body not JSON, use status text
                }

                throw new ApifyError(errorMessage);
            }

            const items = await response.json() as T[];

            console.log(`[ApifyClient] SUCCESS: Retrieved ${items.length} items from Actor ${actorId}`);

            return {
                items,
                run: {
                    status: "SUCCEEDED",
                    finishedAt: new Date().toISOString()
                }
            };
        } catch (error) {
            if (error instanceof ApifyError) {
                throw error;
            }

            // Handle network errors, timeouts, etc.
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[ApifyClient] ERROR: ${message}`);
            throw new ApifyError(`Actor execution failed: ${message}`);
        }
    }

    /**
     * Get dataset items by dataset ID
     *
     * Use this when you have a dataset ID from a previous Actor run
     * and want to retrieve its contents.
     *
     * @param datasetId - Dataset ID from Actor run
     * @param format - Output format (default: "json")
     * @param limit - Maximum number of items to return (default: all)
     * @param offset - Skip first N items (for pagination)
     * @returns Dataset items
     *
     * @example
     * ```typescript
     * const items = await client.getDatasetItems<Tweet>("abc123", "json", 100, 0);
     * ```
     */
    async getDatasetItems<T = any>(
        datasetId: string,
        format: "json" | "csv" = "json",
        limit?: number,
        offset: number = 0
    ): Promise<T[]> {
        let url = `${this.baseUrl}/datasets/${datasetId}/items?token=${this.apiToken}&format=${format}&offset=${offset}`;

        if (limit) {
            url += `&limit=${limit}`;
        }

        console.log(`[ApifyClient] Fetching dataset: ${datasetId} (format: ${format}, offset: ${offset}${limit ? `, limit: ${limit}` : ""})`);

        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new ApifyError(`Dataset fetch failed: ${response.status} ${response.statusText}`);
            }

            const items = await response.json() as T[];

            console.log(`[ApifyClient] Retrieved ${items.length} items from dataset ${datasetId}`);

            return items;
        } catch (error) {
            if (error instanceof ApifyError) {
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            console.error(`[ApifyClient] ERROR: ${message}`);
            throw new ApifyError(`Dataset retrieval failed: ${message}`);
        }
    }

    /**
     * Test connection to Apify API
     *
     * Verifies that the API token is valid by making a minimal API call.
     * Useful for debugging and initialization checks.
     *
     * @returns True if connection successful
     * @throws ApifyError if token is invalid or API is unreachable
     *
     * @example
     * ```typescript
     * try {
     *   await client.testConnection();
     *   console.log("✓ Apify connection OK");
     * } catch (error) {
     *   console.error("✗ Apify connection failed:", error.message);
     * }
     * ```
     */
    async testConnection(): Promise<boolean> {
        // Use /user/me endpoint to verify token
        const url = `${this.baseUrl}/user/me?token=${this.apiToken}`;

        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new ApifyError(`Connection test failed: ${response.status} ${response.statusText}`);
            }

            const userData = await response.json() as any;
            console.log(`[ApifyClient] Connection OK. User: ${userData?.username || "unknown"}`);

            return true;
        } catch (error) {
            if (error instanceof ApifyError) {
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            throw new ApifyError(`Connection test failed: ${message}`);
        }
    }
}

/**
 * Helper: Create ApifyClient from environment
 *
 * @param env - Cloudflare Worker environment with APIFY_API_TOKEN
 * @returns Configured ApifyClient instance
 */
export function createApifyClient(env: { APIFY_API_TOKEN: string }): ApifyClient {
    return new ApifyClient(env.APIFY_API_TOKEN);
}
