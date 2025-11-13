/**
 * Cloudflare AI Gateway Integration
 *
 * This module provides utilities for routing AI requests through Cloudflare AI Gateway with:
 * - Authentication via cf-aig-authorization header
 * - Automatic rate limiting (60 requests/hour per user)
 * - Response caching (1-hour TTL)
 * - Error handling for rate limits and content moderation
 *
 * Documentation: https://developers.cloudflare.com/ai-gateway/
 */

import type { Env } from "./types";

export interface AIGatewayConfig {
  gatewayId: string;
  token: string;
  cacheTtl?: number;
}

export interface AIGatewayResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: number;
    message: string;
  };
  cacheStatus?: "HIT" | "MISS";
}

/**
 * Error codes from AI Gateway
 * Reference: https://developers.cloudflare.com/ai-gateway/reference/error-codes/
 */
export enum AIGatewayErrorCode {
  /** Rate limit exceeded */
  RATE_LIMIT = 429,
  /** Request prompt blocked by Guardrails */
  PROMPT_BLOCKED = 2016,
  /** Response blocked by Guardrails */
  RESPONSE_BLOCKED = 2017,
  /** Invalid gateway authentication */
  UNAUTHORIZED = 401,
  /** Gateway not found */
  NOT_FOUND = 404,
  /** Internal gateway error */
  INTERNAL_ERROR = 500,
}

/**
 * Make an authenticated request to Cloudflare AI Gateway
 *
 * @param config - AI Gateway configuration with ID and token
 * @param provider - AI provider (e.g., "workers-ai", "openai", "anthropic")
 * @param endpoint - Model or endpoint identifier
 * @param requestBody - Request payload to send to the AI provider
 * @returns Response from AI Gateway with cache status
 *
 * @example
 * ```typescript
 * const response = await makeAIGatewayRequest(
 *   { gatewayId: env.AI_GATEWAY_ID, token: env.AI_GATEWAY_TOKEN },
 *   "workers-ai",
 *   "@cf/meta/llama-3.1-8b-instruct",
 *   { prompt: "Tell me a joke" }
 * );
 *
 * if (!response.success) {
 *   if (response.error?.code === 429) {
 *     return { content: [{ type: "text", text: "Rate limit exceeded. Try again later." }], isError: true };
 *   }
 *   if (response.error?.code === 2016) {
 *     return { content: [{ type: "text", text: "Prompt blocked by content policy." }], isError: true };
 *   }
 * }
 *
 * return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
 * ```
 */
export async function makeAIGatewayRequest<T = unknown>(
  config: AIGatewayConfig,
  provider: "workers-ai" | "openai" | "anthropic" | string,
  endpoint: string,
  requestBody: Record<string, unknown>,
  cacheTtl: number = 3600
): Promise<AIGatewayResponse<T>> {
  const { gatewayId, token } = config;

  // Construct gateway URL based on provider
  const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${gatewayId}/${provider}/${endpoint}`;

  console.log(`[AI Gateway] Making authenticated request to ${provider}/${endpoint}`);

  try {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${token}`,
        "cf-aig-cache-ttl": cacheTtl.toString(),
      },
      body: JSON.stringify(requestBody),
    });

    // Get cache status from response headers
    const cacheStatus = (response.headers.get("cf-cache-status") || "MISS") as "HIT" | "MISS";

    // Handle successful response
    if (response.ok) {
      const data = await response.json() as T;
      console.log(`[AI Gateway] ✅ Success (cache: ${cacheStatus})`);
      return { success: true, data, cacheStatus };
    }

    // Handle error responses
    const errorData = await response.json() as { error?: string; message?: string };
    const errorMessage = errorData.error || errorData.message || response.statusText;
    const errorCode = response.status;

    // Log specific error conditions
    if (errorCode === 429) {
      console.log("[AI Gateway] ⚠️ Rate limit exceeded (429)");
    } else if (errorCode === 2016) {
      console.log("[AI Gateway] 🚫 Prompt blocked by Guardrails (2016)");
    } else if (errorCode === 2017) {
      console.log("[AI Gateway] 🚫 Response blocked by Guardrails (2017)");
    } else if (errorCode === 401) {
      console.log("[AI Gateway] ❌ Unauthorized: Invalid authentication token");
    } else {
      console.log(`[AI Gateway] ❌ Error ${errorCode}: ${errorMessage}`);
    }

    return {
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
      },
      cacheStatus,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[AI Gateway] Network error: ${errorMsg}`);

    return {
      success: false,
      error: {
        code: AIGatewayErrorCode.INTERNAL_ERROR,
        message: `Network error: ${errorMsg}`,
      },
    };
  }
}

/**
 * Language strings for error messages
 * Supports English (EN) and Polish (PL)
 */
type Language = "en" | "pl";

interface ErrorMessages {
  title: string;
  description: string;
  suggestion: string;
  contact?: string;
}

const ERROR_MESSAGE_CATALOG: Record<number, Record<Language, ErrorMessages>> = {
  // Rate Limit (429)
  [AIGatewayErrorCode.RATE_LIMIT]: {
    en: {
      title: "Rate Limit Exceeded",
      description: "Your account has reached the limit of 60 requests per hour. This limit protects API stability.",
      suggestion: "Please wait a few minutes before trying again. Consider spacing out your requests over a longer period.",
      contact: "If you need higher limits, contact support.",
    },
    pl: {
      title: "Przekroczono limit żądań",
      description: "Twoje konto osiągnęło limit 60 żądań na godzinę. Ten limit chroni stabilność API.",
      suggestion: "Poczekaj kilka minut przed ponowną próbą. Rozważ rozłożenie żądań na dłuższy okres czasu.",
      contact: "Jeśli potrzebujesz wyższych limitów, skontaktuj się z supportem.",
    },
  },

  // Prompt Blocked (2016) - Content Moderation
  [AIGatewayErrorCode.PROMPT_BLOCKED]: {
    en: {
      title: "Request Blocked - Content Policy Violation",
      description: "Your request was blocked because it contains content that violates our safety policies (violence, hate speech, sexual content, etc.).",
      suggestion: "Please rephrase your request to remove:\n• Violent or hateful language\n• Explicit or sexual content\n• Threats or harassment\n\nTry a more neutral, constructive approach.",
      contact: "If you believe this is an error, contact support.",
    },
    pl: {
      title: "Żądanie zablokowane - Naruszenie polityki treści",
      description: "Twoje żądanie zostało zablokowane, ponieważ zawiera treści naruszające nasze zasady bezpieczeństwa (przemoc, mowa nienawiści, treści seksualne itp.).",
      suggestion: "Zmień sformułowanie żądania, aby usunąć:\n• Przemocę lub mowę nienawiści\n• Treści jawnie seksualne\n• Groźby lub nękanie\n\nSpróbuj bardziej neutralnego, konstruktywnego podejścia.",
      contact: "Jeśli uważasz, że to błąd, skontaktuj się z supportem.",
    },
  },

  // Response Blocked (2017) - Content Moderation
  [AIGatewayErrorCode.RESPONSE_BLOCKED]: {
    en: {
      title: "Response Blocked - Safety Filter",
      description: "The AI's response was blocked because it contains content that violates our safety policies. This is rare and indicates the AI generated harmful content.",
      suggestion: "Try rephrasing your original request to be more specific or specific about what you're trying to accomplish. A different approach may yield safe results.",
    },
    pl: {
      title: "Odpowiedź zablokowana - Filtr bezpieczeństwa",
      description: "Odpowiedź AI została zablokowana, ponieważ zawiera treści naruszające nasze zasady bezpieczeństwa. To zdarzenie jest rzadkie i wskazuje, że AI wygenerowała szkodliwą treść.",
      suggestion: "Spróbuj zmienić formułowanie pierwotnego żądania, aby być bardziej szczegółowym. Inne podejście może dać bezpieczne wyniki.",
    },
  },

  // Unauthorized (401)
  [AIGatewayErrorCode.UNAUTHORIZED]: {
    en: {
      title: "Authentication Error",
      description: "The AI Gateway authentication failed. This is a server configuration issue.",
      suggestion: "Please report this to the system administrator. It's not an issue with your request.",
    },
    pl: {
      title: "Błąd uwierzytelniania",
      description: "Uwierzytelnianie w AI Gateway nie powiodło się. To jest problem z konfiguracją serwera.",
      suggestion: "Zgłoś to administratorowi systemu. To nie jest problem z Twoim żądaniem.",
    },
  },

  // Not Found (404)
  [AIGatewayErrorCode.NOT_FOUND]: {
    en: {
      title: "Service Not Found",
      description: "The AI Gateway or requested model was not found. This is a server configuration issue.",
      suggestion: "Please report this to the system administrator.",
    },
    pl: {
      title: "Usługa nie znaleziona",
      description: "AI Gateway lub żądany model nie został znaleziony. To jest problem z konfiguracją serwera.",
      suggestion: "Zgłoś to administratorowi systemu.",
    },
  },

  // Internal Error (500)
  [AIGatewayErrorCode.INTERNAL_ERROR]: {
    en: {
      title: "Service Error",
      description: "An unexpected error occurred while processing your request.",
      suggestion: "Please try again in a few moments. If the problem persists, contact support.",
    },
    pl: {
      title: "Błąd usługi",
      description: "Podczas przetwarzania Twojego żądania wystąpił nieoczekiwany błąd.",
      suggestion: "Spróbuj ponownie za chwilę. Jeśli problem się powtórzy, skontaktuj się z supportem.",
    },
  },
};

/**
 * Format AI Gateway error response for MCP tool with user-friendly messages
 *
 * @param error - Error object from AI Gateway response
 * @param language - Language for error message ("en" or "pl"), defaults to "en"
 * @returns MCP-formatted error content for LLM
 *
 * @example
 * ```typescript
 * if (!response.success && response.error) {
 *   return {
 *     content: [formatAIGatewayError(response.error, "en")],
 *     isError: true
 *   };
 * }
 * ```
 */
export function formatAIGatewayError(
  error: { code: number; message: string },
  language: Language = "en"
): {
  type: "text";
  text: string;
} {
  const catalog = ERROR_MESSAGE_CATALOG[error.code];

  if (catalog && catalog[language]) {
    const msg = catalog[language];
    let text = `${msg.title}\n\n`;
    text += `${msg.description}\n\n`;
    text += `💡 What to do:\n${msg.suggestion}`;

    if (msg.contact) {
      text += `\n\n📞 ${msg.contact}`;
    }

    return { type: "text" as const, text };
  }

  // Fallback for unknown error codes
  const fallbackMessages: Record<Language, string> = {
    en: `⚠️ An error occurred (Code: ${error.code})\n\nDetails: ${error.message}\n\nPlease try again or contact support if the problem persists.`,
    pl: `⚠️ Wystąpił błąd (Kod: ${error.code})\n\nSzczegóły: ${error.message}\n\nSpróbuj ponownie lub skontaktuj się z supportem, jeśli problem się powtórzy.`,
  };

  return {
    type: "text" as const,
    text: fallbackMessages[language],
  };
}

/**
 * Helper to format AI Gateway cache status for logging
 *
 * @param cacheStatus - Cache status from AI Gateway response
 * @returns Formatted string for logging
 */
export function formatCacheStatus(cacheStatus?: "HIT" | "MISS"): string {
  if (!cacheStatus) return "";
  return cacheStatus === "HIT" ? "⚡ [CACHE HIT]" : "[Cache Miss]";
}
