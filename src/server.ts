import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import type { Props } from "./props";
import { checkBalance, consumeTokensWithRetry } from "./tokenConsumption";
import { formatInsufficientTokensError } from "./tokenUtils";
import { sanitizeOutput, redactPII } from 'pilpat-mcp-security';
import { ApifyClient } from './apify-client';
import { extractYouTubeVideoId, formatTranscriptAsText } from './utils/youtube';
import { getCachedApifyResult, setCachedApifyResult, hashApifyInput } from './apify-cache';
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
            "Extract full transcript from a YouTube video with timestamps. Returns formatted text with [HH:MM:SS] timestamps. ⚠️ Costs 3 tokens per request. Zero cost if no transcript.",
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
                        const preview = cached.transcript ? cached.transcript.substring(0, 2000) : '';
                        return { content: [{ type: "text", text: `✅ Transcript (Cached)\n\nVideo: ${cached.videoId}\nWords: ${cached.wordCount}\n\n${preview}...` }] };
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
                    const transcriptText = formatTranscriptAsText(transcript);
                    const sanitized = sanitizeOutput(transcriptText, { maxLength: 50000, removeHtml: true, removeControlChars: true, normalizeWhitespace: true });
                    const { redacted } = redactPII(sanitized, { redactEmails: false, redactPhones: true, redactCreditCards: true });

                    // Safety check: Ensure we have valid transcript
                    if (!redacted || redacted.trim().length === 0) {
                        return {
                            isError: true,
                            content: [{ type: "text", text: "Transcript extraction failed - no valid text found. No tokens charged." }]
                        };
                    }

                    const finalResult = {
                        videoId,
                        videoUrl: params.videoUrl,
                        transcript: redacted,
                        wordCount: redacted.split(/\s+/).length
                    };

                    // STEP 4.7: Cache
                    await setCachedApifyResult(this.env.CACHE_KV, ACTOR_ID, cacheKey, finalResult, CACHE_TTL);

                    // STEP 5: Consume tokens
                    await consumeTokensWithRetry(this.env.TOKEN_DB, userId, FLAT_COST, "youtube-transcript", TOOL_NAME, params, finalResult, false, actionId);

                    // STEP 6: Return
                    const preview = finalResult.transcript.substring(0, 2000);
                    return {
                        content: [{
                            type: "text",
                            text: `✅ YouTube Transcript\n\nVideo: ${videoId}\nWords: ${finalResult.wordCount}\n\n${preview}...`
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

        // ========================================================================
        // TOOL: get_annotated_summary
        // ========================================================================
        this.server.tool(
            "get_annotated_summary",
            "Get AI-generated summary of YouTube video with timestamped chapters. Uses Workers AI for cleaning and summarization. ⚠️ Costs 5 tokens (3 for transcript + 2 for AI processing). Zero cost if no transcript.",
            {
                videoUrl: z.string().url("Invalid YouTube URL").describe("YouTube video URL (e.g., 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')")
            },
            async (params) => {
                const ACTOR_ID = "faVsWy9VTSNVIhWpR";
                const FLAT_COST = 5;  // 3 for transcript + 2 for AI processing
                const MAX_COST = 5;
                const TOOL_NAME = "get_annotated_summary";
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

                    // STEP 3.5: Check cache for transcript
                    const cacheKey = await hashApifyInput({ actorId: ACTOR_ID, input: { videoUrl: params.videoUrl } });
                    let transcriptData = await getCachedApifyResult(this.env.CACHE_KV, ACTOR_ID, cacheKey);

                    if (!transcriptData) {
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

                        transcriptData = transcript;

                        // STEP 4.7: Cache transcript
                        await setCachedApifyResult(this.env.CACHE_KV, ACTOR_ID, cacheKey, transcriptData, CACHE_TTL);
                    }

                    // STEP 5: Invoke Cloudflare Workflow for AI processing
                    const workflowId = `transcript-${videoId}-${Date.now()}`;
                    const instance = await this.env.TRANSCRIPT_WORKFLOW.create({
                        id: workflowId,
                        params: {
                            videoId,
                            transcriptData
                        }
                    });

                    // Wait for workflow to complete (polls every 2 seconds, max 60 seconds)
                    let workflowResult: any = null;
                    let attempts = 0;
                    const maxAttempts = 30; // 60 seconds total

                    while (attempts < maxAttempts) {
                        const status = await instance.status();

                        if (status.status === 'complete') {
                            workflowResult = status.output;
                            break;
                        } else if (status.status === 'errored') {
                            throw new Error(`Workflow failed: ${status.error || 'Unknown error'}`);
                        }

                        // Wait 2 seconds before next check
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        attempts++;
                    }

                    if (!workflowResult) {
                        throw new Error('Workflow timed out after 60 seconds');
                    }

                    // STEP 6: Consume tokens
                    const finalResult = {
                        videoId,
                        videoUrl: params.videoUrl,
                        summary: workflowResult.summary,
                        wordCount: workflowResult.wordCount,
                        chapterCount: workflowResult.chapterCount
                    };

                    await consumeTokensWithRetry(this.env.TOKEN_DB, userId, FLAT_COST, "youtube-transcript", TOOL_NAME, params, finalResult, false, actionId);

                    // STEP 7: Return
                    return {
                        content: [{
                            type: "text",
                            text: `📺 **AI-Generated Video Summary**\n\n**Video:** ${videoId}\n**Word Count:** ${finalResult.wordCount}\n**Chapters:** ${finalResult.chapterCount}\n\n---\n\n${finalResult.summary}`
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
