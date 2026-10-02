import {
  FORM_SCHEMA,
  REPAIR_SYSTEM,
  VERIFY_SCHEMA,
  VERIFY_SYSTEM,
  buildRepairPrompt,
  buildVerifyPrompt,
} from "../ai/prompts";
import { generateArabicJson } from "../ai/arabicGuard";
import { clampPrompt } from "../ai/gemini";
import type { IExamQuestion } from "../../models/ExamForm";
import type { IExamSet } from "../../models/ExamSet";
import { buildQuestion, type VerifyIssue } from "./questions";
import { renderQuestionsForVerify, type Reviewable } from "./formGenerator";
import type { RangePages } from "./pages";

/**
 * Gemini call (optional, on by default): audit a generated form and repair what
 * is broken.
 *
 * The point is that a wrong MCQ answer key is the one failure mode a student
 * cannot detect and the teacher might not spot either. The verify pass asks a
 * second, cheaper read of the same pages to check each question against its
 * source, and anything it rejects is regenerated rather than merely flagged.
 *
 * Only MCQs are repaired: a short answer's quality is judged by the grading pass
 * against the rubric, and a weak rubric is a judgement call for the teacher, not
 * for a one-shot automatic rewrite.
 */

const VALID_ISSUES: VerifyIssue[] = [
  "none",
  "ambiguous",
  "multiple_correct",
  "not_in_source",
  "bad_distractor",
];

interface RawVerify {
  results?: Array<{ index?: unknown; valid?: unknown; issue?: unknown; note?: unknown }>;
}

export interface VerifyFinding {
  /** Index into the form's `questions` array. */
  index: number;
  valid: boolean;
  issue: VerifyIssue;
  note: string;
}

export interface VerifyResult {
  findings: VerifyFinding[];
  /** Questions rewritten after failing verification. */
  repaired: number;
  /** Questions still suspect after one repair attempt. */
  flagged: number;
}

function coerceIssue(value: unknown): VerifyIssue {
  return VALID_ISSUES.includes(value as VerifyIssue) ? (value as VerifyIssue) : "ambiguous";
}

/**
 * Align the reviewer's verdicts with the questions by index. The model
 * occasionally returns fewer rows than it was given, so a missing row counts as
 * "not checked" and gets flagged rather than silently treated as valid.
 */
export function normaliseFindings(raw: unknown, questionCount: number): VerifyFinding[] {
  const rows = (raw as RawVerify)?.results ?? [];
  const byIndex = new Map<number, VerifyFinding>();

  for (const row of rows) {
    const index = Math.trunc(Number(row?.index));
    if (!Number.isInteger(index) || index < 0 || index >= questionCount) continue;
    if (byIndex.has(index)) continue;

    const issue = coerceIssue(row?.issue);
    const valid = row?.valid === false ? false : row?.valid === true ? true : issue === "none";
    byIndex.set(index, {
      index,
      valid,
      // A rejection with no stated reason is still a rejection; name the most
      // common cause so the review screen shows something actionable.
      issue: !valid && issue === "none" ? "ambiguous" : issue,
      note: String(row?.note ?? "").trim(),
    });
  }

  const findings: VerifyFinding[] = [];
  for (let i = 0; i < questionCount; i++) {
    findings.push(
      byIndex.get(i) ?? { index: i, valid: false, issue: "not_in_source", note: "لم يُراجع هذا السؤال" }
    );
  }
  return findings;
}

export async function verifyQuestions(
  examSet: IExamSet,
  questions: Reviewable[],
  range: RangePages
): Promise<VerifyFinding[]> {
  const raw = await generateArabicJson<RawVerify>(
    [
      {
        text: clampPrompt(
          buildVerifyPrompt(
            renderQuestionsForVerify(questions),
            range.pages,
            examSet.pageFrom,
            examSet.pageTo
          )
        ),
      },
    ],
    {
      schema: VERIFY_SCHEMA as unknown as Record<string, unknown>,
      systemInstruction: VERIFY_SYSTEM,
      temperature: 0,
      maxOutputTokens: 8_192,
    },
    `verify for set ${String(examSet._id)}`
  );

  return normaliseFindings(raw, questions.length);
}

/**
 * Full pass: verify, then try to repair each failure once.
 *
 * Repairs go question by question rather than regenerating the whole form — a
 * question that passed review should not be thrown away because a neighbour was
 * broken.
 */
export async function verifyAndRepair(
  examSet: IExamSet,
  questions: Reviewable[],
  range: RangePages,
  alreadyUsedPrompts: string[]
): Promise<{ questions: IExamQuestion[]; result: VerifyResult }> {
  const findings = await verifyQuestions(examSet, questions, range);
  const working = [...questions] as IExamQuestion[];
  let repaired = 0;
  let flagged = 0;

  for (const finding of findings) {
    const question = working[finding.index];
    if (!question) continue;

    if (finding.valid) {
      question.verify = { status: "ok", issue: "none", note: finding.note, checkedAt: new Date() };
      continue;
    }

    const repairable = question.type === "mcq" && !question.editedByTeacher;
    const fixed = repairable
      ? await rewriteQuestion(
          examSet,
          question,
          finding.issue,
          finding.note,
          range,
          alreadyUsedPrompts
        )
      : null;

    if (fixed) {
      working[finding.index] = fixed;
      repaired++;
      continue;
    }

    question.verify = {
      status: "flagged",
      issue: finding.issue,
      note: finding.note,
      checkedAt: new Date(),
    };
    flagged++;
  }

  return {
    questions: working,
    result: { findings, repaired, flagged },
  };
}

/**
 * Write one replacement question for a rejected or unwanted one.
 *
 * Returns `null` when the model still produces something unusable, in which case
 * the caller flags the question instead of silently swapping in a different
 * broken one. Used both by the verify pass (to repair a failure) and by the
 * review screen (when a teacher dislikes a question).
 */
export async function rewriteQuestion(
  examSet: IExamSet,
  question: IExamQuestion,
  issue: VerifyIssue,
  note: string,
  range: RangePages,
  alreadyUsedPrompts: string[]
): Promise<IExamQuestion | null> {
  const wantedType = question.type;
  const wantedPoints = question.maxPoints;

  const parts = [
    {
      text: clampPrompt(
        buildRepairPrompt({
          pages: range.pages,
          pageFrom: examSet.pageFrom,
          pageTo: examSet.pageTo,
          difficulty: examSet.difficulty,
          broken: {
            type: question.type,
            prompt: question.prompt,
            options: (question.options ?? []).map((o) => o.text),
            topic: question.topic,
          },
          issue,
          note,
          // Everything except the question being replaced, so the replacement
          // cannot collide with its own wording.
          alreadyUsedPrompts: alreadyUsedPrompts.filter((p) => p !== question.prompt),
        })
      ),
    },
  ];

  let raw: { questions?: unknown[] };
  try {
    raw = await generateArabicJson<{ questions?: unknown[] }>(
      parts,
      {
        schema: FORM_SCHEMA as unknown as Record<string, unknown>,
        systemInstruction: REPAIR_SYSTEM,
        temperature: 0.6,
        maxOutputTokens: 4_096,
      },
      `rewrite of set ${String(examSet._id)}`
    );
  } catch (err) {
    console.warn("[verify] rewrite call failed:", err instanceof Error ? err.message : err);
    return null;
  }

  const first = Array.isArray(raw?.questions) ? raw.questions[0] : undefined;
  if (first === undefined) return null;

  const outcome = buildQuestion(first, {
    pageFrom: examSet.pageFrom,
    pageTo: examSet.pageTo,
    topics: (examSet.blueprint?.topics ?? []).map((t) => t.topic),
  });
  if (!outcome.ok) {
    console.warn(`[verify] rewrite produced an unusable question (${outcome.reason})`);
    return null;
  }

  if (outcome.question.type !== wantedType) return null;

  return {
    ...outcome.question,
    // The point value is a teacher-facing parameter, not the model's to change.
    maxPoints: wantedType === "mcq" ? 1 : wantedPoints,
    verify: {
      status: "repaired",
      issue,
      note,
      checkedAt: new Date(),
    },
  } as unknown as IExamQuestion;
}
