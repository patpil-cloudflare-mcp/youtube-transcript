/**
 * Cloudflare Workflow: Transcript Processing
 *
 * Multi-step AI processing pipeline for YouTube transcripts:
 * 1. Fetch transcript from Apify
 * 2. Prepare timestamped text
 * 3. AI clean transcript (remove filler words, fix grammar)
 * 4. AI summarize sections (timestamp-annotated chapters)
 * 5. Save to R2 and generate presigned URL
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { generateObject } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { ApifyClient } from 'apify-client';
import { formatTranscriptAsText } from '../utils/youtube';
import { uploadTextToR2 } from '../utils/r2';
import type { Env } from '../types';

export type TranscriptWorkflowParams = {
    videoId: string;
    transcriptData: any;  // Pass transcript data from tool (already fetched with cache/semaphore)
};

export type TranscriptWorkflowResult = {
    summary: string;
    wordCount: number;
    chapterCount: number;
};

// Zod schemas for AI structured outputs
const cleanedTranscriptSchema = z.object({
    cleanedText: z.string()
});

const summarySchema = z.object({
    summary: z.string()  // Markdown formatted with timestamp headers
});

export class TranscriptProcessingWorkflow extends WorkflowEntrypoint<Env, TranscriptWorkflowParams> {
    async run(event: WorkflowEvent<TranscriptWorkflowParams>, step: WorkflowStep): Promise<TranscriptWorkflowResult> {
        const { videoId, transcriptData } = event.payload;

        // Initialize Workers AI
        const workersai = createWorkersAI({ binding: this.env.AI });
        const model = workersai("@cf/meta/llama-3.1-70b-instruct" as any);

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

        // Step 3: AI Call 1 - Clean transcript (remove filler words, fix grammar)
        const cleanedTranscript = await step.do("clean transcript with AI", async (): Promise<string> => {
            const prompt = `You're an expert transcript editor. Clean the following YouTube video transcript while maintaining all timestamps in [HH:MM:SS] or [MM:SS] format.

RULES:
- NEVER remove timestamps [MM:SS] or [HH:MM:SS] - they are critical metadata
- Remove filler words (um, uh, you know, like, sort of, kind of)
- Eliminate speech stutters, repetitions, false starts
- Fix grammatical errors while maintaining original meaning
- Convert run-on sentences into proper structures with punctuation
- Organize into logical paragraphs where appropriate
- Preserve all factual information, technical details, important concepts
- Return ONLY the cleaned transcript, no additional comments

Transcript to clean:
${timestampedData.timestampedText}`;

            const { object } = await generateObject({
                model,
                schema: cleanedTranscriptSchema,
                prompt: prompt
            });

            return object.cleanedText;
        });

        // Step 4: AI Call 2 - Summarize sections with timestamps
        const summaryMarkdown = await step.do("summarize sections with AI", async (): Promise<string> => {
            const prompt = `You are an expert video analyst. Transform this cleaned transcript into a structured summary of video chapters.

The transcript contains timestamps [HH:MM:SS] or [MM:SS] indicating section starts.

RULES:
- Identify main thematic sections
- For each section: use the timestamp as header, write 2-3 sentence summary
- Return ONLY as Markdown list
- NO introduction, comments, or concluding remarks

EXAMPLE INPUT:
[00:12] Today we'll discuss machine learning. Three main types exist. [01:15] Supervised learning uses labeled data. [04:30] Unsupervised learning finds patterns without labels.

EXAMPLE OUTPUT:
* **[00:12] Introduction to Machine Learning Algorithms**
  The speaker introduces machine learning algorithms and announces three main types will be covered.

* **[01:15] Overview of Supervised Learning**
  Supervised learning is explained, emphasizing its use of labeled data for training models.

* **[04:30] Definition of Unsupervised Learning**
  Unsupervised learning is presented as pattern discovery without predefined labels.

Transcript to summarize:
${cleanedTranscript}`;

            const { object } = await generateObject({
                model,
                schema: summarySchema,
                prompt: prompt
            });

            return object.summary;
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
