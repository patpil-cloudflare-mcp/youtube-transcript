/**
 * Cloudflare Workflow: Transcript Processing
 *
 * Optimized single-pass AI processing pipeline for YouTube transcripts:
 * 1. Prepare timestamped text from Apify data
 * 2. Single AI call (Mistral Small 3.1 24B) - clean AND summarize in one pass
 * 3. Save summary to R2 for archival
 *
 * Performance: 5-10 seconds total (vs 60+ seconds with 2-step approach)
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { formatTranscriptAsText } from '../utils/youtube';
import { uploadTextToR2 } from '../utils/r2';
import type { Env } from '../types';
import { z } from 'zod';

// Structured output schema for chapters
const chapterSchema = z.object({
    chapters: z.array(z.object({
        timestamp: z.string().describe("Timestamp in [HH:MM:SS] or [MM:SS] format"),
        title: z.string().describe("Concise chapter title (3-8 words)"),
        summary: z.string().describe("2-3 sentence summary of the chapter content")
    }))
});

export type TranscriptWorkflowParams = {
    videoId: string;
    transcriptData: any;  // Pass transcript data from tool (already fetched with cache/semaphore)
};

export type TranscriptWorkflowResult = {
    summary: string;
    wordCount: number;
    chapterCount: number;
};

export class TranscriptProcessingWorkflow extends WorkflowEntrypoint<Env, TranscriptWorkflowParams> {
    async run(event: WorkflowEvent<TranscriptWorkflowParams>, step: WorkflowStep): Promise<TranscriptWorkflowResult> {
        const { videoId, transcriptData } = event.payload;

        // Step 1: Prepare timestamped text (convert Apify format to readable text)
        const timestampedData = await step.do("prepare timestamped text", async (): Promise<{ timestampedText: string; rawText: string; wordCount: number }> => {
            const timestampedText = formatTranscriptAsText(transcriptData);

            // Extract raw text from data array
            const rawText = Array.isArray(transcriptData.data)
                ? transcriptData.data.filter((item: any) => item.text && item.text.trim())
                    .map((item: any) => item.text).join(' ')
                : '';

            return {
                timestampedText,
                rawText,
                wordCount: rawText.split(/\s+/).length
            };
        });

        // Step 3: Single AI Call - Clean AND Summarize in one pass with STRUCTURED OUTPUT (optimized for quality + speed)
        const chaptersStructured = await step.do("generate clean summary with AI", async () => {
            const systemPrompt = `You are an expert video analyst and transcript editor. Extract thematic chapters from YouTube video transcripts.

TASK:
1. Identify major thematic sections (typically 3-8 chapters)
2. For each chapter: extract timestamp, create title (3-8 words), write 2-3 sentence summary
3. Remove filler words (um, uh, you know, like) from summaries
4. Use clear, professional language
5. Preserve all factual information and key concepts

IMPORTANT:
- Use the EXACT timestamp where each section begins
- Titles should be concise and descriptive
- Summaries should capture the main points discussed in that section
- Focus on content, not presentation style`;

            const userPrompt = `Extract chapters from this transcript:

${timestampedData.timestampedText}`;

            console.log('[Workflow] Calling Mistral Small 3.1 24B via AI Gateway (structured output)...');
            const startTime = Date.now();

            // Use Workers AI binding with structured output
            const response = await this.env.AI.run(
                '@cf/mistralai/mistral-small-3.1-24b-instruct' as any,
                {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    response_format: {
                        type: 'json_schema',
                        json_schema: {
                            name: 'chapter_extraction',
                            strict: true,
                            schema: {
                                type: 'object',
                                properties: {
                                    chapters: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                timestamp: {
                                                    type: 'string',
                                                    description: 'Timestamp in [HH:MM:SS] or [MM:SS] format'
                                                },
                                                title: {
                                                    type: 'string',
                                                    description: 'Concise chapter title (3-8 words)'
                                                },
                                                summary: {
                                                    type: 'string',
                                                    description: '2-3 sentence summary of chapter content'
                                                }
                                            },
                                            required: ['timestamp', 'title', 'summary'],
                                            additionalProperties: false
                                        }
                                    }
                                },
                                required: ['chapters'],
                                additionalProperties: false
                            }
                        }
                    },
                    max_tokens: 8192
                },
                {
                    gateway: {
                        id: this.env.AI_GATEWAY_ID,  // "mcp-production-gateway"
                        cacheTtl: 3600  // 1 hour cache
                    }
                }
            ) as any;

            const elapsed = Date.now() - startTime;
            console.log(`[Workflow] Mistral response received in ${elapsed}ms (structured output)`);

            // Parse structured response
            const parsed = typeof response.response === 'string'
                ? JSON.parse(response.response)
                : response.response;

            // Validate with Zod schema
            const validated = chapterSchema.parse(parsed);

            console.log(`[Workflow] Extracted ${validated.chapters.length} chapters`);
            return validated;
        });

        // Step 3.5: Format structured chapters into markdown
        const summaryMarkdown = await step.do("format chapters as markdown", async (): Promise<string> => {
            const formatted = chaptersStructured.chapters.map(chapter => {
                // Ensure timestamp has brackets
                const timestamp = chapter.timestamp.startsWith('[')
                    ? chapter.timestamp
                    : `[${chapter.timestamp}]`;

                return `* **${timestamp} ${chapter.title}**\n    ${chapter.summary}`;
            }).join('\n\n');

            console.log(`[Workflow] Formatted ${chaptersStructured.chapters.length} chapters as markdown`);
            return formatted;
        });

        // Step 5: Save transcript to R2 for archival (optional)
        await step.do("save transcript to R2", async (): Promise<boolean> => {
            try {
                const r2Key = `${videoId}_summary_${Date.now()}.txt`;
                await uploadTextToR2(this.env.R2_TRANSCRIPTS, r2Key, summaryMarkdown);
                console.log(`[Workflow] Saved summary to R2: ${r2Key}`);
                return true;
            } catch (error) {
                console.error(`[Workflow] Failed to save to R2:`, error);
                return false;  // Don't fail workflow if R2 upload fails
            }
        });

        // Return final workflow result (summary only - full transcript already available from original tool)
        return {
            summary: summaryMarkdown,
            wordCount: timestampedData.wordCount,
            chapterCount: (summaryMarkdown.match(/\*\*/g) || []).length / 2  // Count markdown headers
        };
    }
}
