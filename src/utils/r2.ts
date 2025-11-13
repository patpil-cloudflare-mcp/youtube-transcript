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

/**
 * Upload transcript text to R2 for archival (optional backup)
 *
 * @param r2Bucket - R2 bucket binding from env
 * @param videoId - YouTube video ID (used as filename prefix)
 * @param content - Transcript text content to upload
 * @param fileType - Type of file ('raw' | 'summary')
 * @returns R2 object key
 */
export async function uploadTranscriptToR2(
    r2Bucket: R2Bucket,
    videoId: string,
    content: string,
    fileType: 'raw' | 'summary' = 'raw'
): Promise<string> {
    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const filename = `${videoId}/${fileType}-${timestamp}.txt`;

    // Upload to R2
    await r2Bucket.put(filename, content, {
        httpMetadata: {
            contentType: 'text/plain; charset=utf-8',
            contentDisposition: `attachment; filename="${videoId}-${fileType}.txt"`
        },
        customMetadata: {
            videoId,
            fileType,
            uploadedAt: new Date().toISOString()
        }
    });

    console.log(`[R2] Uploaded ${fileType} transcript for video ${videoId}: ${filename}`);

    return filename;
}
