/**
 * R2 Storage Utility Functions
 *
 * Functions for uploading and retrieving content from R2
 */

/**
 * Uploads text content to R2
 * @param bucket - R2 bucket binding
 * @param key - Object key
 * @param content - Text content
 * @returns Upload result
 */
export async function uploadTextToR2(
    bucket: R2Bucket,
    key: string,
    content: string
): Promise<{ success: boolean; size: number }> {
    await bucket.put(key, content, {
        httpMetadata: {
            contentType: 'text/plain; charset=utf-8'
        }
    });

    return {
        success: true,
        size: content.length
    };
}

/**
 * Retrieves text content from R2
 * @param bucket - R2 bucket binding
 * @param key - Object key
 * @returns Text content or null if not found
 */
export async function getTextFromR2(
    bucket: R2Bucket,
    key: string
): Promise<string | null> {
    const object = await bucket.get(key);

    if (!object) {
        return null;
    }

    return await object.text();
}
