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

        // Step 3: Single AI Call - Clean AND Summarize in one pass (optimized for speed)
        const summaryMarkdown = await step.do("generate clean summary with AI", async (): Promise<string> => {
            const prompt = `You are an expert video analyst and transcript editor. Your task is to transform a raw YouTube video transcript into a clean, structured chapter summary.

**Your Task (2-in-1):**
1. Clean the transcript by removing filler words, stutters, and repetitions
2. Identify thematic sections and create timestamped chapter summaries

**Input Format:**
The transcript contains timestamps in [HH:MM:SS] or [MM:SS] format followed by spoken text.

**Output Format:**
Return ONLY a Markdown list of chapters with timestamps and summaries.

<rules>
- Read the entire transcript to understand the full context
- Identify major thematic sections (typically 3-8 chapters for most videos)
- For each chapter:
  1. Use the timestamp where that section begins as the header
  2. Write a concise 2-3 sentence summary of what was discussed
- Remove filler words (um, uh, you know, like, sort of) from your summaries
- Fix grammatical errors and use clear, professional language
- Preserve all factual information, technical details, and key concepts
- Return ONLY the markdown list - no introduction, no concluding remarks
- Each chapter should be a bullet point with bold timestamp + title, followed by indented description
</rules>

<example_input_transcript>
[00:12] Um, so today we're gonna, you know, talk about machine learning, like, algorithms and stuff. There are, uh, three main types. [01:15] The first type is, um, supervised learning, right? It works on, like, labeled data which the algorithm, you know, learns from. This allows it to predict outcomes for new data. [04:30] The second type is unsupervised learning. In this case, we don't have labels. The goal is to find hidden patterns or structures in the data, for example, through clustering.
</example_input_transcript>

<example_ai_response>
* **[00:12] Introduction to Machine Learning Algorithms**
    The speaker introduces the topic of machine learning algorithms and announces a discussion of three main types. This sets the foundation for understanding different approaches to machine learning.

* **[01:15] Overview of Supervised Learning**
    This section explains supervised learning, which uses labeled data to train models capable of predicting outcomes for new data. The algorithm learns patterns from the training examples.

* **[04:30] Definition of Unsupervised Learning**
    Unsupervised learning is presented as an approach that operates on unlabeled data. Its purpose is to discover internal structures and patterns, such as through clustering techniques.
</example_ai_response>

**Transcript to process:**
${timestampedData.timestampedText}`;

            console.log('[Workflow] Calling Mistral Small 3.1 24B via AI Gateway (single-pass clean + summarize)...');
            const startTime = Date.now();

            // Use Workers AI binding with gateway option (auto-authenticated, no token needed)
            const response = await this.env.AI.run(
                '@cf/mistralai/mistral-small-3.1-24b-instruct' as any,
                {
                    prompt: prompt,
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
            console.log(`[Workflow] Mistral response received in ${elapsed}ms`);

            return response.response || '';
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
