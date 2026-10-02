import {
  GRADE_SCHEMA,
  GRADE_SYSTEM,
  buildGradePrompt,
  type GradingItem,
} from "../ai/prompts";
import { generateArabicJson } from "../ai/arabicGuard";
import type { IExamQuestion } from "../../models/ExamForm";
import type { IExamSet } from "../../models/ExamSet";
import type { Confidence } from "../../models/ExamAttempt";

/**
 * One batched Gemini call per submit: grade every short answer on the paper at once.
 *
 * The resilience rule matters more than the grading. If the call fails, or the model
 * returns something unusable, every short answer is stored as zero with
 * `aiConfidence: "low"` and flagged `needsReview`. The student's result is never
 * blocked and never silently wrong-looking — a paper that is waiting for a teacher
 * says so, instead of reporting a grade the model invented.
 */

export interface GradableShortAnswer {
  question: Pick<IExamQuestion, "prompt" | "modelAnswer" | "rubric" | "maxPoints">;
  studentAnswer: string;
}

export interface GradedShortAnswer {
  score: number;
  max: number;
  feedback: string;
  confidence: Confidence;
  /** True when this grade is a placeholder rather than a real judgement. */
  pending: boolean;
}

export type GradedShortAnswers = Map<string, GradedShortAnswer>;

interface RawGrade {
  results?: Array<{ index?: unknown; score?: unknown; feedback?: unknown; confidence?: unknown }>;
}

const VALID_CONFIDENCE: Confidence[] = ["high", "medium", "low"];

function asConfidence(value: unknown): Confidence {
  return VALID_CONFIDENCE.includes(value as Confidence) ? (value as Confidence) : "low";
}

/**
 * Force a model score into `[0, max]`.
 *
 * A structured-output model can still return 7 for a 2-point question, and a grade
 * above the maximum would inflate the total past `maxGrade` — so the clamp happens
 * here, once, rather than being trusted.
 */
function clampScore(value: unknown, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n * 100) / 100));
}

function pendingResult(max: number): GradedShortAnswer {
  return { score: 0, max, feedback: "", confidence: "low", pending: true };
}

/**
 * Grade a set of short answers, keyed by question id.
 *
 * `questionId` is not in the `GradingItem` because the prompt refers to answers by
 * index; the index→id mapping is this function's job, so the two cannot drift.
 */
export async function gradeShortAnswers(
  examSet: IExamSet,
  answers: Array<{ questionId: string; answer: GradableShortAnswer }>
): Promise<GradedShortAnswers> {
  const out: GradedShortAnswers = new Map();
  if (answers.length === 0) return out;

  const items: GradingItem[] = [];
  const indexToId: string[] = [];

  for (const { questionId, answer } of answers) {
    const max = answer.question.maxPoints ?? 0;
    // A blank answer is zero with no call spent on it, and the student is told so.
    if (!answer.studentAnswer.trim()) {
      out.set(questionId, {
        score: 0,
        max,
        feedback: "",
        confidence: "high",
        pending: false,
      });
      continue;
    }
    indexToId.push(questionId);
    items.push({
      index: items.length,
      prompt: answer.question.prompt,
      modelAnswer: answer.question.modelAnswer ?? "",
      rubric: answer.question.rubric ?? [],
      maxPoints: max,
      studentAnswer: answer.studentAnswer,
    });
  }

  if (items.length === 0) return out;

  let raw: RawGrade;
  try {
    raw = await generateArabicJson<RawGrade>(
      [{ text: buildGradePrompt(items) }],
      {
        schema: GRADE_SCHEMA as unknown as Record<string, unknown>,
        systemInstruction: GRADE_SYSTEM,
        temperature: 0,
        maxOutputTokens: 4_096,
      },
      `grading for attempt on set ${String(examSet._id)}`
    );
  } catch (err) {
    // The student still gets a result; every short answer waits for a teacher.
    console.error("gradeShortAnswers: falling back to pending review:", err);
    items.forEach((item, index) => {
      out.set(indexToId[index], pendingResult(item.maxPoints));
    });
    return out;
  }

  const byIndex = new Map<number, NonNullable<RawGrade["results"]>[number]>();
  for (const row of raw?.results ?? []) {
    if (typeof row?.index === "number") byIndex.set(row.index, row);
  }

  items.forEach((item, index) => {
    const questionId = indexToId[index];
    const row = byIndex.get(index);
    if (!row) {
      // The model skipped this answer. Same treatment as a failed call: zero and a
      // human decision, rather than a guess.
      out.set(questionId, { score: 0, max: item.maxPoints, feedback: "", confidence: "low", pending: true });
      return;
    }
    out.set(questionId, {
      score: clampScore(row.score, item.maxPoints),
      max: item.maxPoints,
      feedback: typeof row.feedback === "string" ? row.feedback.trim() : "",
      confidence: asConfidence(row.confidence),
      pending: false,
    });
  });

  return out;
}
