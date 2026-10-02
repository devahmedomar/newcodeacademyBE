import { FORM_SCHEMA, FORM_SYSTEM, buildFormPrompt } from "../ai/prompts";
import { generateArabicJson } from "../ai/arabicGuard";
import { clampPrompt, type AiPart } from "../ai/gemini";
import { ExamForm, computeMaxGrade, type IExamQuestion, type IExamQuestionDoc } from "../../models/ExamForm";
import type { IExamSet } from "../../models/ExamSet";
import {
  buildForm,
  orderQuestions,
  reconcileCounts,
  toRawQuestion,
  usedPromptList,
  type BuiltQuestion,
  type FormLabel,
  type RejectedQuestion,
} from "./questions";
import type { RangePages } from "./pages";

/**
 * Gemini call #2..N+1: one distinct paper per form.
 *
 * Each call receives the blueprint (so every form covers the same ground) and
 * the prompts already used by its siblings (so no two students can be handed the
 * same question). The client drives one call per form rather than the server
 * doing all of them, because a single request has to finish inside the
 * serverless time limit.
 */

/** A form is one request; a long paper needs a long output budget. */
const MAX_OUTPUT_TOKENS = 16_384;

/** Anything with the question fields, stored or freshly built. */
export type Reviewable = IExamQuestion | BuiltQuestion;

export interface GeneratedForm {
  label: FormLabel;
  questions: BuiltQuestion[];
  /** Raw items the model produced that failed validation. */
  rejected: RejectedQuestion[];
  /** Items dropped because a sibling form already used that wording. */
  duplicates: number;
  /** Extra items dropped to hit the requested counts. */
  trimmed: number;
  /** Requested questions the model did not manage to produce. */
  missing: { mcq: number; short: number };
}

function requireBlueprint(examSet: IExamSet): NonNullable<IExamSet["blueprint"]> {
  const bp = examSet.blueprint;
  if (!bp || !Array.isArray(bp.topics) || bp.topics.length === 0) {
    throw new Error("This exam set has no blueprint yet. Run the blueprint step first.");
  }
  return bp;
}

export async function generateForm(
  examSet: IExamSet,
  label: FormLabel,
  range: RangePages,
  alreadyUsedPrompts: string[] = []
): Promise<GeneratedForm> {
  const blueprint = requireBlueprint(examSet);

  const prompt = buildFormPrompt({
    pages: range.pages,
    pageFrom: examSet.pageFrom,
    pageTo: examSet.pageTo,
    mcqCount: examSet.mcqCount,
    shortCount: examSet.shortCount,
    difficulty: examSet.difficulty,
    topics: blueprint.topics.map((t) => ({
      topic: t.topic,
      weight: Number(t.weight) || 1,
      keywords: Array.isArray(t.keywords) ? t.keywords : [],
    })),
    alreadyUsedPrompts,
    formLabel: label,
  });

  const parts: AiPart[] = [{ text: clampPrompt(prompt) }];
  const raw = await generateArabicJson<{ questions?: unknown[] }>(
    parts,
    {
      schema: FORM_SCHEMA as unknown as Record<string, unknown>,
      systemInstruction: FORM_SYSTEM,
      // A little heat helps variety across forms; too much loses the source text.
      temperature: 0.7,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    `form ${label} of set ${String(examSet._id)}`
  );

  const built = buildForm(raw?.questions, {
    pageFrom: examSet.pageFrom,
    pageTo: examSet.pageTo,
    topics: blueprint.topics.map((t) => t.topic),
    mcqCount: examSet.mcqCount,
    shortCount: examSet.shortCount,
    alreadyUsed: alreadyUsedPrompts,
  });

  const reconciled = reconcileCounts(built.questions, {
    mcqCount: examSet.mcqCount,
    shortCount: examSet.shortCount,
  });

  return {
    label,
    questions: reconciled.questions,
    rejected: built.rejected,
    duplicates: built.duplicates,
    trimmed: reconciled.trimmed,
    missing: reconciled.missing,
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Write a generated form, replacing any previous version of the same label.
 *
 * `upsert` keeps the set's `_id`s stable, so a teacher reviewing form B while the
 * client regenerates form C does not lose their place.
 */
export async function saveForm(
  examSetId: string,
  label: FormLabel,
  questions: BuiltQuestion[],
  status: "draft" | "ready" = "draft"
): Promise<IExamQuestionDoc[]> {
  const stored = orderQuestions(questions) as unknown as IExamQuestion[];

  const doc = await ExamForm.findOneAndUpdate(
    { examSetId, formLabel: label },
    {
      $set: {
        questions: stored,
        maxGrade: computeMaxGrade(stored),
        status,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return doc.questions;
}

/**
 * The prompts of every other form, so the next call can be told to avoid them.
 * `label` is a plain string because it comes straight off a stored document; it
 * only ever reaches a `$ne` comparison.
 */
export function promptsOfOtherForms(examSetId: string, label: string): Promise<string[]> {
  return ExamForm.find({ examSetId, formLabel: { $ne: label } })
    .select("questions")
    .lean()
    .then((forms) => usedPromptList(forms as unknown as Array<{ questions: IExamQuestion[] }>));
}

/* -------------------------------------------------------------------------- */
/* Rendering for review                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The form as the verify prompt sees it: the same JSON the model produced,
 * including the answer key, because the reviewer has to judge which option is
 * right. This is a teacher-only path and never reaches a student response.
 */
export function renderQuestionsForVerify(questions: Reviewable[]): string {
  return JSON.stringify(questions.map(toRawQuestion), null, 1);
}
