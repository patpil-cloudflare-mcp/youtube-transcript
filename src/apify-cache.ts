/**
 * Apify Result Caching with Cloudflare KV
 *
 * CRITICAL: This implements the "KV-Only Hot Cache" pattern from apify_docs.md
 *
 * Problem: Popular resources (viral tweets, trending videos) get requested repeatedly.
 * Without caching, each request costs:
 * - Apify API call ($$$)
 * - Token consumption from user
 * - 30-60s wait time
 *
 * Solution: 15-minute KV cache for hot queries
 *
 * Benefits:
 * - Cache hit = 0 Apify cost (50-70% cost reduction)
 * - Instant response (<50ms vs 30s+)
 * - Still charge user tokens (100% margin)
 * - No semaphore slot consumed on cache hit
 *
 * Flow (CRITICAL ORDER):
 * 1. Check balance
 * 2. Check cache (KV) ← BEFORE semaphore
 * 3. If HIT: Return cached, skip semaphore entirely
 * 4. If MISS: Acquire semaphore → Call Apify → Cache result
 *
 * Cache Key Strategy:
 * - Format: "apify:{actorId}:{inputHash}"
 * - inputHash = SHA-256 of sorted JSON input
 * - Example: "apify:twitter-scraper:a3f2c8b9..."
 *
 * @see /Users/patpil/cloudflare_mcp_projects/cloudflare_mcp_apify/apify_docs.md
 */

import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Get cached Apify result from KV
 *
 * CRITICAL: Call this BEFORE acquiring semaphore slot.
 * Cache hit avoids wasting a precious slot on data that's already available.
 *
 * @param kv - KV namespace (CACHE_KV)
 * @param actorId - Apify Actor ID
 * @param inputHash - SHA-256 hash of Actor input (from hashApifyInput)
 * @param cacheTTL - Cache TTL in seconds (default: 900 = 15 minutes)
 * @returns Cached result or null if cache miss
 *
 * @example
 * ```typescript
 * // CORRECT: Check cache BEFORE semaphore
 * const inputHash = await hashApifyInput(params);
 * const cached = await getCachedApifyResult(env.CACHE_KV, "twitter-scraper", inputHash);
 *
 * if (cached) {
 *   console.log("[Cache HIT] Returning cached data");
 *   return { content: [{ type: "text", text: JSON.stringify(cached) }] };
 * }
 *
 * // Cache miss - proceed with semaphore + Apify
 * const slot = await semaphore.acquireSlot(userId, actorId);
 * ...
 * ```
 */
export async function getCachedApifyResult<T = any>(
    kv: KVNamespace,
    actorId: string,
    inputHash: string,
    cacheTTL?: number
): Promise<T | null> {
    const cacheKey = buildCacheKey(actorId, inputHash);

    console.log(`[ApifyCache] Checking cache: ${cacheKey}`);

    try {
        const cached = await kv.get(cacheKey, "json");

        if (cached) {
            console.log(`[ApifyCache] ✓ HIT: ${cacheKey}`);
            return cached as T;
        }

        console.log(`[ApifyCache] ✗ MISS: ${cacheKey}`);
        return null;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ApifyCache] ERROR: Cache read failed - ${message}`);
        // Return null on error (treat as cache miss)
        return null;
    }
}

/**
 * Store Apify result in KV cache
 *
 * Call this AFTER successful Apify execution and BEFORE returning to user.
 * Next request with same input will hit cache instead of calling Apify.
 *
 * @param kv - KV namespace (CACHE_KV)
 * @param actorId - Apify Actor ID
 * @param inputHash - SHA-256 hash of Actor input
 * @param result - Result data to cache
 * @param cacheTTL - Cache TTL in seconds (default: 900 = 15 minutes)
 *
 * @example
 * ```typescript
 * // After successful Apify execution
 * const result = await apifyClient.runActorSync(...);
 *
 * // Cache for next request
 * await setCachedApifyResult(
 *   env.CACHE_KV,
 *   "twitter-scraper",
 *   inputHash,
 *   result.items,
 *   900
 * );
 * ```
 */
export async function setCachedApifyResult(
    kv: KVNamespace,
    actorId: string,
    inputHash: string,
    result: any,
    cacheTTL: number = 900
): Promise<void> {
    const cacheKey = buildCacheKey(actorId, inputHash);

    console.log(`[ApifyCache] Storing: ${cacheKey} (TTL: ${cacheTTL}s)`);

    try {
        await kv.put(cacheKey, JSON.stringify(result), {
            expirationTtl: cacheTTL,
            metadata: {
                cachedAt: Date.now(),
                actorId,
                resultCount: Array.isArray(result) ? result.length : 1,
                ttl: cacheTTL
            }
        });

        console.log(`[ApifyCache] ✓ STORED: ${cacheKey}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ApifyCache] ERROR: Cache write failed - ${message}`);
        // Don't throw - cache failure shouldn't break the response
    }
}

/**
 * Generate deterministic hash from Apify Actor input
 *
 * CRITICAL: Hash must be deterministic (same input = same hash).
 * This ensures cache hits for identical requests.
 *
 * Strategy:
 * 1. Sort object keys alphabetically
 * 2. Stringify to JSON
 * 3. SHA-256 hash
 * 4. Convert to hex string
 *
 * @param input - Apify Actor input object
 * @returns SHA-256 hash (hex string)
 *
 * @example
 * ```typescript
 * const input = { username: "elonmusk", maxTweets: 100 };
 * const hash = await hashApifyInput(input);
 * // hash: "a3f2c8b9..." (deterministic)
 *
 * // Same input = same hash
 * const hash2 = await hashApifyInput({ maxTweets: 100, username: "elonmusk" });
 * // hash2: "a3f2c8b9..." (identical despite key order)
 * ```
 */
export async function hashApifyInput(input: any): Promise<string> {
    // Sort keys for deterministic hashing
    const sortedKeys = Object.keys(input).sort();
    const sortedInput: Record<string, any> = {};

    for (const key of sortedKeys) {
        sortedInput[key] = input[key];
    }

    const jsonString = JSON.stringify(sortedInput);

    // SHA-256 hash
    const encoder = new TextEncoder();
    const data = encoder.encode(jsonString);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);

    // Convert to hex string
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    console.log(`[ApifyCache] Input hash: ${hashHex.substring(0, 16)}...`);

    return hashHex;
}

/**
 * Build cache key from actor ID and input hash
 *
 * Format: "apify:{actorId}:{inputHash}"
 * - Namespace: "apify:" for easy identification
 * - Actor ID: Ensures isolation between different Actors
 * - Input hash: Uniquely identifies request parameters
 *
 * @param actorId - Apify Actor ID
 * @param inputHash - SHA-256 hash from hashApifyInput
 * @returns KV cache key
 *
 * @example
 * buildCacheKey("twitter-scraper", "a3f2c8b9...")
 * // → "apify:twitter-scraper:a3f2c8b9..."
 */
function buildCacheKey(actorId: string, inputHash: string): string {
    return `apify:${actorId}:${inputHash}`;
}

/**
 * Invalidate cache for specific Actor + input
 *
 * Use this when you know data has changed and cache should be cleared.
 * Rare in Apify use cases (scrapes are point-in-time snapshots).
 *
 * @param kv - KV namespace (CACHE_KV)
 * @param actorId - Apify Actor ID
 * @param inputHash - SHA-256 hash of Actor input
 *
 * @example
 * ```typescript
 * // Force fresh scrape by invalidating cache
 * await invalidateCache(env.CACHE_KV, "twitter-scraper", inputHash);
 * const freshResult = await apifyClient.runActorSync(...);
 * ```
 */
export async function invalidateCache(
    kv: KVNamespace,
    actorId: string,
    inputHash: string
): Promise<void> {
    const cacheKey = buildCacheKey(actorId, inputHash);

    console.log(`[ApifyCache] Invalidating: ${cacheKey}`);

    try {
        await kv.delete(cacheKey);
        console.log(`[ApifyCache] ✓ INVALIDATED: ${cacheKey}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ApifyCache] ERROR: Cache invalidation failed - ${message}`);
    }
}

/**
 * Get cache statistics (for monitoring/debugging)
 *
 * Retrieves metadata for a cached entry without deserializing the full data.
 * Useful for debugging cache behavior.
 *
 * @param kv - KV namespace (CACHE_KV)
 * @param actorId - Apify Actor ID
 * @param inputHash - SHA-256 hash of Actor input
 * @returns Cache metadata or null if not found
 *
 * @example
 * ```typescript
 * const stats = await getCacheStats(env.CACHE_KV, "twitter-scraper", inputHash);
 * if (stats) {
 *   console.log(`Cache age: ${Date.now() - stats.cachedAt}ms`);
 *   console.log(`Result count: ${stats.resultCount}`);
 * }
 * ```
 */
export async function getCacheStats(
    kv: KVNamespace,
    actorId: string,
    inputHash: string
): Promise<{
    cachedAt: number;
    actorId: string;
    resultCount: number;
    ttl: number;
} | null> {
    const cacheKey = buildCacheKey(actorId, inputHash);

    try {
        const metadata = await kv.getWithMetadata(cacheKey);

        if (!metadata.metadata) {
            return null;
        }

        return metadata.metadata as any;
    } catch (error) {
        console.error(`[ApifyCache] ERROR: Stats retrieval failed`);
        return null;
    }
}
