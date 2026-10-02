import { GoogleGenAI, Type } from "@google/genai";
import pRetry, { AbortError } from "p-retry";

/**
 * Thin, retrying wrapper around the Gemini Developer API.
 *
 * Every call goes through `pRetry` with exponential backoff so the free tier's
 * 429/RPM/RPD limits degrade into a slow success rather than a user-facing error.
 */

let cachedClient: GoogleGenAI | null = null;
let cachedKey: string | null = null;

export function isAiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function getModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
}

function getClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not defined");
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new GoogleGenAI({ apiKey: key });
    cachedKey = key;
  }
  return cachedClient;
}

/** Content parts accepted by generateContent. Text plus inline image bytes. */
export type AiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** 1M token context on current models, but keep prompts sane and cheap. */
const MAX_PROMPT_CHARS = 400_000;

export function clampPrompt(text: string): string {
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return `${text.slice(0, MAX_PROMPT_CHARS)}\n\n[تم اختصار بقية النص لطول السياق]`;
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b(429|500|502|503|504)\b|RESOURCE_EXSUMED|UNAVAILABLE|rate limit|overloaded/i.test(msg);
}

const RETRY_OPTS = {
  retries: 5,
  factor: 2,
  minTimeout: 2_000,
  maxTimeout: 45_000,
  randomize: true,
} as const;

async function call(
  parts: AiPart[],
  config: Record<string, unknown>
): Promise<string> {
  const ai = getClient();
  return pRetry(
    async () => {
      const res = await ai.models.generateContent({
        model: getModel(),
        contents: parts,
        config,
      });
      const text = res.text ?? "";
      if (!text.trim()) {
        // Empty output is usually a truncated/filtered response — worth one retry.
        const err = new Error("Gemini returned an empty response") as Error & { retryable?: boolean };
        err.retryable = true;
        throw err;
      }
      return text;
    },
    {
      ...RETRY_OPTS,
      onFailedAttempt(err) {
        if (!isRetryable(err) && !(err as { retryable?: boolean }).retryable) {
          // Non-transient problems (bad key, malformed schema) must fail fast.
          throw new AbortError(err instanceof Error ? err : new Error(String(err)));
        }
        console.warn(
          `[gemini] attempt ${err.attemptNumber} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      },
    }
  );
}

export interface StructuredOptions {
  /** JSON Schema. Restricted to the subset Gemini structured output supports. */
  schema: Record<string, unknown>;
  /** Applied to every attempt; useful for injecting the "answer in Arabic" rule. */
  systemInstruction?: string;
  temperature?: number;
  /** Response size headroom for the model's thinking tokens. */
  maxOutputTokens?: number;
}

/**
 * Generate content constrained by a response schema and parse it as JSON.
 * Throws if the model returns something that is not valid JSON.
 */
export async function generateJson<T>(parts: AiPart[], opts: StructuredOptions): Promise<T> {
  const text = await call(parts, {
    responseMimeType: "application/json",
    responseSchema: opts.schema,
    ...(opts.systemInstruction
      ? { systemInstruction: { role: "system", parts: [{ text: opts.systemInstruction }] } }
      : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  });

  try {
    return JSON.parse(stripCodeFence(text)) as T;
  } catch {
    throw new Error(`Gemini returned unparseable JSON: ${text.slice(0, 300)}`);
  }
}

export interface TextOptions {
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

/** Free-form text generation. */
export async function generateText(parts: AiPart[], opts: TextOptions = {}): Promise<string> {
  return call(parts, {
    ...(opts.systemInstruction
      ? { systemInstruction: { role: "system", parts: [{ text: opts.systemInstruction }] } }
      : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  });
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\n?/, "");
  return withoutOpen.replace(/\n?```$/, "").trim();
}

/** Re-exported so callers build schemas without importing the SDK directly. */
export { Type };

/** Guard used by routes so an unconfigured deployment fails with a clear message. */
export function assertAiConfigured(): void {
  if (!isAiConfigured()) {
    throw new Error("AI features are not configured: set GEMINI_API_KEY");
  }
}
