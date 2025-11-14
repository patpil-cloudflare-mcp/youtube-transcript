import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import type { Props } from "./props";
import { checkBalance, consumeTokensWithRetry } from "./tokenConsumption";
import { formatInsufficientTokensError } from "./tokenUtils";
import { sanitizeOutput, redactPII } from 'pilpat-mcp-security';
import { ApifyClient } from './apify-client';
import { extractYouTubeVideoId, formatRawTranscript } from './utils/youtube';
import { getCachedApifyResult, setCachedApifyResult, hashApifyInput } from './apify-cache';
import { uploadTranscriptToR2, getR2PublicUrl } from './utils/r2-helpers';
import type { SemaphoreSlot } from './types';

export class YoutubeTranscript extends McpAgent<Env, unknown, Props> {
    server = new McpServer({
        name: "YouTube Transcript MCP",
        version: "1.0.0",
    });

    async init() {
        // ========================================================================
        // TOOL: get_youtube_transcript
        // ========================================================================
        this.server.tool(
            "get_youtube_transcript",
            "Extract full transcript from a YouTube video and save to R2 file. Returns download URL to raw transcript text (no timestamps). ⚠️ Costs 3 tokens per request. Zero cost if no transcript. File expires after 24 hours.",
            {
                videoUrl: z.string().url("Invalid YouTube URL").describe("YouTube video URL (e.g., 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')")
            },
            async (params) => {
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
                    const videoId = extractYouTubeVideoId(params.videoUrl);
                    if (!videoId) throw new Error("Invalid YouTube URL format");

                    const userId = this.props?.userId;
                    if (!userId) throw new Error("User ID not found");

                    // STEP 2: Check balance
                    const balanceCheck = await checkBalance(this.env.TOKEN_DB, userId, MAX_COST);
                    if (!balanceCheck.sufficient) {
                        return {
                            isError: true,
                            content: [{
                                type: "text",
                                text: formatInsufficientTokensError(TOOL_NAME, balanceCheck.currentBalance, MAX_COST)
                            }]
                        };
                    }

                    // STEP 3.5: Check cache
                    const cacheKey = await hashApifyInput({ actorId: ACTOR_ID, input: { videoUrl: params.videoUrl } });
                    const cached = await getCachedApifyResult(this.env.CACHE_KV, ACTOR_ID, cacheKey);

                    if (cached) {
                        await consumeTokensWithRetry(this.env.TOKEN_DB, userId, FLAT_COST, "youtube-transcript", TOOL_NAME, params, cached, true, actionId);
                        const r2Url = cached.r2Url || getR2PublicUrl("youtube-transcripts", videoId);
                        return { content: [{ type: "text", text: `✅ YouTube Transcript (Cached)\n\nVideo: ${videoId}\nWords: ${cached.wordCount}\n\nDownload: ${r2Url}` }] };
                    }

                    // STEP 3.7: Acquire semaphore
                    const semaphoreId = this.env.APIFY_SEMAPHORE.idFromName("global");
                    const semaphore = this.env.APIFY_SEMAPHORE.get(semaphoreId) as any;
                    slot = await semaphore.acquireSlot(userId, ACTOR_ID);

                    // STEP 4: Execute Actor
                    const apifyClient = new ApifyClient(this.env.APIFY_API_TOKEN);
                    const actorInput = { videoUrl: params.videoUrl };
                    const results = await apifyClient.runActorSync(ACTOR_ID, actorInput, TIMEOUT);

                    const transcript = results.items[0] || null;
                    if (!transcript || !transcript.data || !Array.isArray(transcript.data) || transcript.data.length === 0) {
                        return {
                            isError: true,
                            content: [{ type: "text", text: "No transcript available. No tokens charged." }]
                        };
                    }

                    // STEP 4.4-4.5: Format & Security
                    const rawTranscript = formatRawTranscript(transcript);
                    const sanitized = sanitizeOutput(rawTranscript, { maxLength: 500000, removeHtml: true, removeControlChars: true, normalizeWhitespace: true });
                    const { redacted } = redactPII(sanitized, { redactEmails: false, redactPhones: true, redactCreditCards: true });

                    // Safety check: Ensure we have valid transcript
                    if (!redacted || redacted.trim().length === 0) {
                        return {
                            isError: true,
                            content: [{ type: "text", text: "Transcript extraction failed - no valid text found. No tokens charged." }]
                        };
                    }

                    // STEP 4.6: Upload to R2
                    await uploadTranscriptToR2(this.env.R2_TRANSCRIPTS, videoId, redacted);
                    const r2Url = getR2PublicUrl("youtube-transcripts", videoId);

                    const finalResult = {
                        videoId,
                        videoUrl: params.videoUrl,
                        r2Url,
                        wordCount: redacted.split(/\s+/).length
                    };

                    // STEP 4.7: Cache
                    await setCachedApifyResult(this.env.CACHE_KV, ACTOR_ID, cacheKey, finalResult, CACHE_TTL);

                    // STEP 5: Consume tokens
                    await consumeTokensWithRetry(this.env.TOKEN_DB, userId, FLAT_COST, "youtube-transcript", TOOL_NAME, params, finalResult, false, actionId);

                    // STEP 6: Return
                    return {
                        content: [{
                            type: "text",
                            text: `✅ YouTube Transcript\n\nVideo: ${videoId}\nWords: ${finalResult.wordCount}\n\nDownload: ${r2Url}`
                        }]
                    };

                } catch (error) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }]
                    };
                } finally {
                    // CRITICAL: Always release semaphore
                    if (slot && this.props?.userId) {
                        const semaphoreId = this.env.APIFY_SEMAPHORE.idFromName("global");
                        const semaphore = this.env.APIFY_SEMAPHORE.get(semaphoreId) as any;
                        await semaphore.releaseSlot(this.props.userId);
                    }
                }
            }
        );
    }
}
