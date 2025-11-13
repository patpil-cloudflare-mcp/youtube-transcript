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
            const prompt = `You're now an expert transcript editor, focused solely on transforming raw YouTube video transcripts into clean, professional, and readable text while maintaining all important information.

Your ONLY goal is to reformat and clean the transcript provided by the user, removing all unnecessary elements while preserving the essential content and detailed information.

<rules>
- NEVER remove timestamps in the format [MM:SS] or [HH:MM:SS]. They are critical metadata and must remain intact, associated with the text that immediately follows them.
- Remove all filler words and phrases (um, uh, you know, like, sort of, kind of, etc.)
- Eliminate speech stutters, repetitions, and false starts
- Fix grammatical errors while maintaining the original meaning
- Convert run-on sentences into proper structures with appropriate punctuation
- Organize content into logical paragraphs where appropriate
- Preserve all factual information, technical details, and important concepts
- Maintain the original flow and sequence of ideas
- Return ONLY the cleaned transcript, with no additional comments or explanations
- Use markdown formatting (headings, bullet points) when clearly indicated in the content
</rules>

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
            const prompt = `You are an expert video analyst. Your task is to transform a cleaned transcript into a structured summary of its chapters.

The transcript contains timestamps in the format [HH:MM:SS] or [MM:SS] that indicate the start of a thought.

<rules>
- Read the entire cleaned transcript.
- Identify the main thematic sections.
- For each section:
  1. Use the timestamp that begins that section as the header.
  2. Write a concise summary (2-3 sentences) of what was discussed in that section.
- Return the result ONLY as a Markdown list.
- Do NOT add any introduction, comments, or concluding remarks.
</rules>

<example_input_transcript>
[00:12] Today we'll talk about machine learning algorithms. There are three main types. [01:15] The first type is supervised learning. It works on labeled data, which the algorithm learns from. This allows it to predict outcomes for new data. [04:30] The second type is unsupervised learning. In this case, we don't have labels. The goal is to find hidden patterns or structures in the data, for example, through clustering.
</example_input_transcript>

<example_ai_response>
* **[00:12] Introduction to Machine Learning Algorithms**
    The speaker introduces the topic of machine learning algorithms and announces a discussion of three main types.

* **[01:15] Overview of Supervised Learning**
    This section explains that supervised learning uses labeled data to train models capable of predicting outcomes.

* **[04:30] Definition of Unsupervised Learning**
    In contrast, unsupervised learning is presented, which operates on unlabeled data. Its purpose is to discover internal structures, such as through clustering.
</example_ai_response>

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
