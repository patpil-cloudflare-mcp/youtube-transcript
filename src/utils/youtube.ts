/**
 * YouTube Utility Functions
 *
 * Functions for extracting video IDs and formatting transcripts
 */

/**
 * Extracts YouTube video ID from various URL formats
 * @param url - YouTube URL (watch, youtu.be, embed, etc.)
 * @returns Video ID or null if invalid
 */
export function extractYouTubeVideoId(url: string): string | null {
    try {
        const parsedUrl = new URL(url);

        // Format: https://www.youtube.com/watch?v=VIDEO_ID
        if (parsedUrl.hostname.includes('youtube.com') && parsedUrl.searchParams.has('v')) {
            return parsedUrl.searchParams.get('v');
        }

        // Format: https://youtu.be/VIDEO_ID
        if (parsedUrl.hostname === 'youtu.be') {
            return parsedUrl.pathname.substring(1);
        }

        // Format: https://www.youtube.com/embed/VIDEO_ID
        if (parsedUrl.pathname.startsWith('/embed/')) {
            return parsedUrl.pathname.split('/')[2];
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Formats Apify transcript result as plain text with timestamps
 * @param transcript - Apify Actor output with searchResult array
 * @returns Formatted transcript text
 */
export function formatTranscriptAsText(transcript: any): string {
    if (!transcript.searchResult || !Array.isArray(transcript.searchResult)) {
        return '';
    }

    return transcript.searchResult
        .map((item: any) => {
            // Actor returns 'start' in seconds as string, convert to number
            const timestamp = formatTimestamp(parseFloat(item.start));
            return `[${timestamp}] ${item.text}`;
        })
        .join('\n\n');
}

/**
 * Formats seconds as HH:MM:SS or MM:SS
 * @param seconds - Time offset in seconds
 * @returns Formatted timestamp
 */
function formatTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
