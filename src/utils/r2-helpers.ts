/**
 * R2 Helper Utilities for YouTube Transcript Storage
 *
 * Simple utilities for uploading transcripts to R2 and generating public URLs.
 * Files are automatically cleaned up after 24 hours via R2 lifecycle rule.
 *
 * Lifecycle Rule: 'daily-cleanup' (configured via wrangler)
 * - Expires objects after 1 day
 * - No manual cleanup code needed
 */

import type { R2Bucket } from "@cloudflare/workers-types";

/**
 * Upload raw transcript text to R2 bucket
 *
 * File path: `transcripts/{videoId}.txt`
 * Content-Type: `text/plain; charset=utf-8`
 * TTL: 24 hours (via lifecycle rule, not customMetadata)
 *
 * @param bucket - R2 bucket binding (R2_TRANSCRIPTS)
 * @param videoId - YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @param rawTranscript - Raw transcript text (no timestamps)
 * @returns Promise<void>
 *
 * @example
 * ```typescript
 * await uploadTranscriptToR2(
 *   env.R2_TRANSCRIPTS,
 *   "dQw4w9WgXcQ",
 *   "This is the raw transcript text..."
 * );
 * ```
 */
export async function uploadTranscriptToR2(
    bucket: R2Bucket,
    videoId: string,
    rawTranscript: string
): Promise<void> {
    const key = `transcripts/${videoId}.txt`;

    console.log(`[R2] Uploading transcript: ${key} (${rawTranscript.length} bytes)`);

    try {
        await bucket.put(key, rawTranscript, {
            httpMetadata: {
                contentType: "text/plain; charset=utf-8",
            },
            customMetadata: {
                videoId,
                uploadedAt: new Date().toISOString(),
                source: "youtube-transcript-mcp",
            },
        });

        console.log(`[R2] ✓ Upload successful: ${key}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[R2] ✗ Upload failed: ${message}`);
        throw new Error(`R2 upload failed: ${message}`);
    }
}

/**
 * Generate public R2 URL for a transcript file
 *
 * Returns a fully-qualified HTTPS URL to the transcript file served via the Worker.
 * URL format: `https://youtube-transcript.wtyczki.ai/r2/transcripts/{videoId}.txt`
 *
 * The Worker handles R2 file serving via the /r2/* route in index.ts.
 * Files are automatically cleaned up after 24 hours via R2 lifecycle rule.
 *
 * @param bucketName - R2 bucket name (e.g., "youtube-transcripts") - unused but kept for API compatibility
 * @param videoId - YouTube video ID
 * @returns Public HTTPS URL to the transcript file
 *
 * @example
 * ```typescript
 * const url = getR2PublicUrl("youtube-transcripts", "dQw4w9WgXcQ");
 * // Returns: "https://youtube-transcript.wtyczki.ai/r2/transcripts/dQw4w9WgXcQ.txt"
 * ```
 */
export function getR2PublicUrl(bucketName: string, videoId: string): string {
    // Use the Worker's custom domain for branded, clickable URLs
    // The /r2/* route in index.ts proxies requests to the R2 bucket
    return `https://youtube-transcript.wtyczki.ai/r2/transcripts/${videoId}.txt`;
}

/**
 * Check if a transcript file exists in R2
 *
 * Useful for cache validation and debugging.
 *
 * @param bucket - R2 bucket binding
 * @param videoId - YouTube video ID
 * @returns True if file exists, false otherwise
 */
export async function transcriptExistsInR2(
    bucket: R2Bucket,
    videoId: string
): Promise<boolean> {
    const key = `transcripts/${videoId}.txt`;

    try {
        const object = await bucket.head(key);
        return object !== null;
    } catch (error) {
        console.error(`[R2] Error checking existence: ${error}`);
        return false;
    }
}

/**
 * Get transcript file from R2
 *
 * Used for debugging or manual retrieval.
 *
 * @param bucket - R2 bucket binding
 * @param videoId - YouTube video ID
 * @returns Transcript text or null if not found
 */
export async function getTranscriptFromR2(
    bucket: R2Bucket,
    videoId: string
): Promise<string | null> {
    const key = `transcripts/${videoId}.txt`;

    try {
        const object = await bucket.get(key);
        if (!object) {
            console.log(`[R2] File not found: ${key}`);
            return null;
        }

        const text = await object.text();
        console.log(`[R2] Retrieved transcript: ${key} (${text.length} bytes)`);
        return text;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[R2] Error retrieving file: ${message}`);
        return null;
    }
}
