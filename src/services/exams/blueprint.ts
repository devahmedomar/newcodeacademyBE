import { BLUEPRINT_SCHEMA, BLUEPRINT_SYSTEM, buildBlueprintPrompt } from "../ai/prompts";
import type { AiPart } from "../ai/gemini";
import { generateArabicJson } from "../ai/arabicGuard";
import { sanitizeModelText } from "../ai/validate";
import type { RangePages } from "./pages";
import { clampInt, normalizeForCompare } from "./questions";
import type { IBlueprintTopic, IExamSet } from "../../models/ExamSet";

/**
 * Gemini call #1: read the page range and return a weighted topic map.
 *
 * Every form in the set is built from this map, which is what stops one student
 * getting an easy paper and another a hard one — they are all asked about the
 * same ground, just from different angles.
 */

/** The prompt asks for 4..12; anything beyond that is noise in the form prompt. */
const MIN_TOPICS = 1;
const MAX_TOPICS = 12;
const MAX_KEYWORDS = 4;

interface RawBlueprint {
  topics?: Array<{ topic?: unknown; weight?: unknown; keywords?: unknown }>;
  summary?: unknown;
}

export interface BlueprintResult {
  topics: IBlueprintTopic[];
  summary: string;
}

/**
 * Normalise a raw blueprint. Weights and keyword counts are clamped rather than
 * rejected, because a slightly malformed blueprint is still usable and the
 * teacher reviews everything before a set is published.
 */
export function normaliseBlueprint(raw: unknown): BlueprintResult {
  const input = (raw ?? {}) as RawBlueprint;
  const seen = new Set<string>();

  const topics: IBlueprintTopic[] = [];
  for (const t of Array.isArray(input.topics) ? input.topics : []) {
    const name = sanitizeModelText(String(t?.topic ?? ""));
    if (name.length < 3) continue;

    const key = normalizeForCompare(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const keywords = (Array.isArray(t?.keywords) ? t.keywords : [])
      .map((k) => sanitizeModelText(String(k ?? "")))
      .filter((k) => k.length > 0)
      .filter((k, _i, all) => all.findIndex((o) => normalizeForCompare(o) === normalizeForCompare(k)) === _i)
      .slice(0, MAX_KEYWORDS);

    topics.push({
      topic: name,
      weight: clampInt(t?.weight, 1, 3, 1),
      keywords,
    });

    if (topics.length >= MAX_TOPICS) break;
  }

  if (topics.length < MIN_TOPICS) {
    throw new Error("The model returned no usable topics for this page range");
  }

  // Weight-3 topics first: the prompt lists them in order and the model weights
  // its coverage towards the front of the list.
  topics.sort((a, b) => b.weight - a.weight);

  return { topics, summary: sanitizeModelText(String(input.summary ?? "")) };
}

export async function generateBlueprint(examSet: IExamSet, range: RangePages): Promise<BlueprintResult> {
  const parts: AiPart[] = [
    { text: buildBlueprintPrompt(range.pages, examSet.pageFrom, examSet.pageTo) },
  ];

  const raw = await generateArabicJson<RawBlueprint>(
    parts,
    {
      schema: BLUEPRINT_SCHEMA as unknown as Record<string, unknown>,
      systemInstruction: BLUEPRINT_SYSTEM,
      temperature: 0.2,
      maxOutputTokens: 8_192,
    },
    `blueprint for set ${String(examSet._id)}`
  );

  return normaliseBlueprint(raw);
}
