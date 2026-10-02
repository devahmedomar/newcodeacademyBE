import { Types } from "mongoose";
import type { IExamForm, IExamQuestion, IExamQuestionDoc } from "../../models/ExamForm";
import type { IExamAttempt, IAttemptAnswer } from "../../models/ExamAttempt";
import { buildShufflePlan, type ShufflePlan } from "./shuffle";

/**
 * The student half of the exam pipeline: handing out a paper, taking answers back,
 * scoring them, and telling the student what they got.
 *
 * The ordering and the scoring are pure functions over plain data so they can be
 * tested without Mongo. Only the routes touch the database.
 *
 * The rule that governs all of it: before submitting, a student never receives
 * `correctOptionId`, `modelAnswer`, `rubric` or `explanation`. Those appear only on
 * a result, and only for that student's own attempt.
 */

/**
 * How many sittings a student gets if the set does not say.
 *
 * The same shape as the existing `MAX_QUIZ_ATTEMPTS`, which is the precedent the
 * plan points at for capping attempts in code rather than with a database
 * constraint — a cap enforced by a unique index cannot tell a draft from a real
 * sitting, and cannot be raised per set.
 */
export const MAX_EXAM_ATTEMPTS = 2;

/** Long enough for a paragraph, short enough to refuse a pasted essay dump. */
const MAX_TEXT_ANSWER = 4_000;

/**
 * `mongoose.Types.ObjectId` and the `ObjectId` that `new Types.ObjectId()` returns
 * are two different types — one is the schema type, one is the driver. Casting once
 * here keeps that mismatch in one place instead of at every construction site.
 */
const asRef = (id: Types.ObjectId | string): IAttemptAnswer["questionId"] =>
  id as unknown as IAttemptAnswer["questionId"];

export type PublicQuestion = {
  id: string;
  type: "mcq" | "short";
  prompt: string;
  /** MCQ only, in this student's order. Short answers have none. */
  options: Array<{ id: string; text: string }>;
  maxPoints: number;
};

export interface Paper {
  questions: PublicQuestion[];
  maxGrade: number;
}

/**
 * The paper as this student will see it: this student's question order, this
 * student's option order, and nothing that could mark the answer.
 */
export function buildStudentPaper(form: IExamForm, plan: ShufflePlan): Paper {
  const byId = new Map<string, IExamQuestionDoc>();
  form.questions.forEach((q) => byId.set(String(q._id), q));

  const questions: PublicQuestion[] = [];
  for (const id of plan.questionOrder) {
    const q = byId.get(String(id));
    if (!q) continue;
    const order = plan.optionOrder[String(id)];
    const options = (q.options ?? []).map((o) => ({ id: o.id, text: o.text }));
    questions.push({
      id: String(q._id),
      type: q.type,
      prompt: q.prompt,
      // The permutation is a list of ids, not a reordering of the text, so an
      // option that is somehow missing from the stored order cannot drop an option.
      options: order?.length
        ? order.map((oid) => options.find((o) => o.id === oid)).filter((o): o is { id: string; text: string } => Boolean(o))
        : options,
      maxPoints: q.maxPoints,
    });
  }

  return { questions, maxGrade: form.maxGrade };
}

/** The plan for a new attempt. */
export function planForAttempt(
  questions: IExamQuestionDoc[],
  seed: string
): ShufflePlan {
  return buildShufflePlan(
    questions.map((q) => ({ _id: q._id, type: q.type, options: q.options ?? [] })),
    seed
  );
}

export interface SubmittedAnswer {
  questionId: string;
  chosenOptionId?: string;
  textAnswer?: string;
}

export interface NormalisedSubmission {
  answers: IAttemptAnswer[];
  /** Question ids the client sent that are not on this paper. */
  unknownQuestionIds: string[];
  /** Question ids sent more than once. The last one wins. */
  duplicateQuestionIds: string[];
}

/**
 * Check a submission against the paper it claims to answer.
 *
 * Validation is strict on purpose. A question id from another form, or an option id
 * that is not on the question, is not a formatting mistake to be tidied away — it is
 * a client that is not looking at this paper, and accepting it would put an answer
 * on a record that the grading then treats as real. Text is trimmed and capped.
 */
export function normaliseSubmission(
  form: IExamForm,
  submitted: SubmittedAnswer[]
): NormalisedSubmission {
  const byId = new Map<string, IExamQuestionDoc>();
  form.questions.forEach((q) => byId.set(String(q._id), q));

  // Keyed by question, so a client that sends the same question twice — a retry
  // that appended rather than replaced, say — ends up with one answer, the last one,
  // and never two rows that would then be double-counted in the total.
  const answers = new Map<string, IAttemptAnswer>();
  const unknownQuestionIds: string[] = [];
  const duplicateQuestionIds: string[] = [];
  const seen = new Set<string>();

  for (const item of submitted) {
    const questionId = String(item?.questionId ?? "");
    const question = byId.get(questionId);
    if (!question) {
      if (questionId) unknownQuestionIds.push(questionId);
      continue;
    }
    if (seen.has(questionId)) duplicateQuestionIds.push(questionId);
    seen.add(questionId);

    if (question.type === "mcq") {
      const chosen = String(item.chosenOptionId ?? "");
      if (!chosen) {
        // An MCQ with no choice is unanswered, i.e. wrong. Dropping the row is how
        // a cleared answer is represented.
        answers.delete(questionId);
        continue;
      }
      const valid = (question.options ?? []).some((o) => o.id === chosen);
      if (!valid) {
        throw new Error(`option ${chosen} does not belong to question ${questionId}`);
      }
      answers.set(questionId, {
        questionId: asRef(new Types.ObjectId(questionId)),
        type: "mcq",
        chosenOptionId: chosen,
        isCorrect: chosen === question.correctOptionId,
        textAnswer: "",
      });
      continue;
    }

    // A short question is answered with text. A `chosenOptionId` sent for one is
    // ignored rather than rejected: it carries no meaning, and refusing the whole
    // submission over it would throw away a real answer.
    const text = String(item.textAnswer ?? "").trim().slice(0, MAX_TEXT_ANSWER);
    if (!text) {
      answers.delete(questionId);
      continue;
    }
    answers.set(questionId, {
      questionId: asRef(new Types.ObjectId(questionId)),
      type: "short",
      textAnswer: text,
    });
  }

  return { answers: [...answers.values()], unknownQuestionIds, duplicateQuestionIds };
}

export interface McqScoring {
  answers: IAttemptAnswer[];
  mcqScore: number;
  mcqMax: number;
}

/**
 * Score the objective half.
 *
 * Only what the student actually answered is written back, so an unanswered MCQ is
 * absent from the record and scores as zero at the total. Marks come from each
 * question's own `maxPoints` rather than an assumed 1, in case a future set allows
 * MCQs worth more.
 */
export function scoreMcq(
  form: IExamForm,
  submitted: SubmittedAnswer[]
): McqScoring {
  const { answers } = normaliseSubmission(form, submitted);
  const mcq = answers.filter((a) => a.type === "mcq");
  const maxById = new Map(form.questions.map((q) => [String(q._id), q.maxPoints]));
  const mcqScore = mcq.reduce((sum, a) => sum + (a.isCorrect ? (maxById.get(String(a.questionId)) ?? 0) : 0), 0);
  const mcqMax = form.questions
    .filter((q) => q.type === "mcq")
    .reduce((sum, q) => sum + q.maxPoints, 0);
  return { answers: mcq, mcqScore, mcqMax };
}

/**
 * Fold the two halves into the totals the student sees.
 *
 * A `teacherScore` beats the AI's `aiScore`, because a teacher override is the last
 * word on a disputed answer. Percent is rounded to one decimal so a 2/3 does not
 * render as `66.66666666666667`.
 */
export function totalise(input: {
  answers: IAttemptAnswer[];
  mcqScore: number;
  shortMax: number;
  aiShortScore: number;
  maxGrade: number;
}): { mcqScore: number; shortScore: number; totalScore: number; maxGrade: number; percent: number; needsReview: boolean } {
  const { answers, mcqScore, shortMax, aiShortScore, maxGrade } = input;
  const effective = answers
    .filter((a) => a.type === "short")
    .map((a) => a.teacherScore ?? a.aiScore ?? 0)
    .reduce((sum, n) => sum + n, 0);

  const shortScore = Math.min(effective, shortMax);
  const totalScore = mcqScore + shortScore;
  const percent = maxGrade > 0 ? Math.round((totalScore / maxGrade) * 1000) / 10 : 0;
  const needsReview = answers.some(
    (a) => a.type === "short" && a.teacherScore === undefined && (a.aiConfidence === "low" || a.aiScore === undefined)
  );

  return { mcqScore, shortScore, totalScore, maxGrade, percent, needsReview };
}

/** Whether a set still accepts a new or resumed attempt right now. */
export function availability(
  set: { status: string; openUntil?: Date | null },
  now: Date
): { ok: true } | { ok: false; reason: string } {
  if (set.status !== "published") {
    return { ok: false, reason: "This exam is not open." };
  }
  if (set.openUntil && new Date(set.openUntil).getTime() <= now.getTime()) {
    return { ok: false, reason: "This exam has closed." };
  }
  return { ok: true };
}

/**
 * A draft's own deadline, when the set limits time.
 *
 * Measured from when the draft was created, and it does not extend when the paper is
 * resumed: a student who leaves a paper open overnight has lost it, and a
 * `timeLimitMinutes` that restarted on every page load would not be a time limit.
 */
export function draftDeadline(
  draft: { createdAt: Date; timeLimitMinutes?: number },
  now: Date
): Date | null {
  if (!draft.timeLimitMinutes) return null;
  return new Date(new Date(draft.createdAt).getTime() + draft.timeLimitMinutes * 60_000);
}

/** Whether a draft may still be saved to or submitted. */
export function draftStillOpen(
  draft: { createdAt: Date; timeLimitMinutes?: number },
  now: Date,
  graceMinutes = 0
): { ok: true } | { ok: false; reason: string } {
  const deadline = draftDeadline(draft, now);
  if (deadline && deadline.getTime() + graceMinutes * 60_000 <= now.getTime()) {
    return { ok: false, reason: "Your time for this attempt has run out." };
  }
  return { ok: true };
}

/**
 * The window in which a paper can still be handed in after its clock runs out.
 *
 * The clock is enforced strictly for opening and saving — past it the paper is
 * closed — but a submit that is already in flight when the timer reaches zero must
 * not be thrown away, so handing in gets a short grace period. Without it a
 * student who finished exactly on time would be left holding a draft that can
 * never be submitted at all.
 */
export const SUBMIT_GRACE_MINUTES = 2;

/** Attempts still available. Drafts are not attempts until they are submitted. */
export function attemptsLeft(maxAttempts: number | undefined, submittedCount: number): number {
  const cap = Number.isFinite(maxAttempts) && (maxAttempts as number) > 0 ? (maxAttempts as number) : MAX_EXAM_ATTEMPTS;
  return Math.max(0, cap - submittedCount);
}

/** Read the stored option order whether mongoose handed back a Map or an object. */
export function optionOrderFor(attempt: IExamAttempt, questionId: string): string[] {
  const order = attempt.optionOrder as unknown as Map<string, string[]> | Record<string, string[]>;
  if (!order) return [];
  if (order instanceof Map) return order.get(questionId) ?? [];
  return (order as Record<string, string[]>)[questionId] ?? [];
}

/**
 * A result, in the order the student saw the questions.
 *
 * This is the one response that includes the answer key, the model answer, the rubric
 * and the explanation — after submitting, on the student's own attempt only. The
 * questions come back in `questionOrder`, so the review reads in the same sequence
 * the exam did.
 */
export function serialiseAttempt(
  attempt: IExamAttempt,
  form: IExamForm | null
): Record<string, unknown> {
  const byId = new Map<string, IExamQuestionDoc>();
  form?.questions.forEach((q) => byId.set(String(q._id), q));
  const answerById = new Map<string, IAttemptAnswer>();
  attempt.answers.forEach((a) => answerById.set(String(a.questionId), a));

  const questions = attempt.questionOrder
    .map((id) => {
      const q = byId.get(String(id));
      if (!q) return null;
      const order = optionOrderFor(attempt, String(id));
      const options = (q.options ?? []).map((o) => ({ id: o.id, text: o.text }));
      const answer = answerById.get(String(q._id));
      return {
        id: String(q._id),
        type: q.type,
        prompt: q.prompt,
        options: order.length
          ? order.map((oid) => options.find((o) => o.id === oid)).filter((o): o is { id: string; text: string } => Boolean(o))
          : options,
        maxPoints: q.maxPoints,
        // Everything below is post-submit only.
        correctOptionId: q.correctOptionId ?? null,
        explanation: q.explanation ?? "",
        modelAnswer: q.modelAnswer ?? null,
        rubric: q.rubric ?? [],
        chosenOptionId: answer?.chosenOptionId ?? null,
        isCorrect: answer?.isCorrect ?? false,
        textAnswer: answer?.textAnswer ?? "",
        aiScore: answer?.teacherScore ?? answer?.aiScore ?? null,
        aiMax: answer?.aiMax ?? q.maxPoints,
        aiFeedback: answer?.teacherFeedback ?? answer?.aiFeedback ?? "",
        aiConfidence: answer?.aiConfidence ?? null,
        overriddenByTeacher: answer?.teacherScore !== undefined,
      };
    })
    .filter((q): q is NonNullable<typeof q> => q !== null);

  return {
    _id: String(attempt._id),
    examSetId: String(attempt.examSetId),
    formId: String(attempt.formId),
    status: attempt.status,
    mcqScore: attempt.mcqScore,
    shortScore: attempt.shortScore,
    totalScore: attempt.totalScore,
    maxGrade: attempt.maxGrade,
    percent: attempt.percent,
    needsReview: attempt.needsReview,
    timeLimitMinutes: attempt.timeLimitMinutes ?? null,
    questions,
    submittedAt: attempt.submittedAt ?? null,
    gradedAt: attempt.gradedAt ?? null,
    createdAt: (attempt as unknown as { createdAt?: Date }).createdAt ?? null,
  };
}

/** A question's own marks, for the grading pass. */
export function gradableFrom(question: IExamQuestionDoc) {
  return {
    prompt: question.prompt,
    modelAnswer: question.modelAnswer ?? "",
    rubric: question.rubric ?? [],
    maxPoints: question.maxPoints,
  };
}

/* -------------------------------------------------------------------------- */
/* Teacher override                                                            */
/* -------------------------------------------------------------------------- */

/** Long enough for a marker's note, short enough to refuse a pasted essay dump. */
const MAX_TEACHER_FEEDBACK = 2_000;

export interface OverrideInput {
  questionId: string;
  /** `null` or `""` clears the override and hands the answer back to the AI's mark. */
  teacherScore?: number | string | null;
  teacherFeedback?: string | null;
}

export type OverrideOutcome =
  | { ok: true; answers: IAttemptAnswer[]; changed: boolean }
  | { ok: false; reason: string };

/**
 * A plain object for one answer.
 *
 * A live Mongoose subdocument keeps its data under `_doc`, so `{ ...answer }` copies
 * the document plumbing and none of the fields — spreading one and then reading
 * `type` back gets `undefined`. The routes pass real documents, the tests pass plain
 * objects, and both have to work.
 */
function toPlainAnswer(answer: IAttemptAnswer): IAttemptAnswer {
  const withToObject = answer as unknown as { toObject?: () => IAttemptAnswer };
  if (typeof withToObject.toObject === "function") return withToObject.toObject();
  return { ...answer };
}

/**
 * A teacher setting a short answer's mark by hand.
 *
 * Three rules, each of which exists because of a way this can go wrong:
 *
 * 1. **Only short answers.** An MCQ is machine-marked against a key that is the
 *    definition of right, so a hand-set mark would contradict the paper's own
 *    marking scheme rather than refine it.
 * 2. **Clamped to the question's own marks.** A slip of the keyboard must not be
 *    able to hand out more than the question is worth, and `totalise` would clamp
 *    the total anyway — leaving the per-answer figure and the total disagreeing.
 * 3. **An empty score clears the override** rather than recording a zero, so a
 *    teacher who changes their mind gets the AI's own mark back instead of a
 *    hand-set zero that looks deliberate.
 *
 * The answers are copied, not mutated: the caller decides when to save.
 */
export function applyTeacherOverride(
  answers: IAttemptAnswer[],
  input: OverrideInput,
  maxById: Map<string, number>
): OverrideOutcome {
  const questionId = String(input.questionId ?? "").trim();
  if (!questionId) return { ok: false, reason: "questionId is required" };

  const index = answers.findIndex((a) => String(a.questionId) === questionId);
  if (index === -1) {
    return { ok: false, reason: "That question was not answered on this attempt." };
  }
  const answer = answers[index];
  if (answer.type !== "short") {
    return { ok: false, reason: "Only written answers can be marked by hand." };
  }

  const raw = input.teacherScore;
  const clearing = raw === null || raw === undefined || raw === "";
  const score = clearing ? 0 : Number(raw);
  if (!Number.isFinite(score)) {
    return { ok: false, reason: "The mark must be a number." };
  }
  const max = maxById.get(questionId) ?? answer.aiMax ?? 0;
  const clamped = Math.max(0, Math.min(max, Math.round(score * 100) / 100));
  const feedback = String(input.teacherFeedback ?? "").trim().slice(0, MAX_TEACHER_FEEDBACK);

  const next: IAttemptAnswer = toPlainAnswer(answer);
  if (clearing) {
    delete next.teacherScore;
    delete next.teacherFeedback;
    delete next.overriddenBy;
    delete next.overriddenAt;
    // `aiConfidence` is deliberately left alone: it is the model's own opinion, and
    // a teacher changing their mind has not made the model more confident. Clearing
    // an override on a low-confidence answer puts it back in the review queue, which
    // is the point of clearing it.
  } else {
    next.teacherScore = clamped;
    if (feedback) next.teacherFeedback = feedback;
    else delete next.teacherFeedback;
  }

  const changed =
    next.teacherScore !== answer.teacherScore ||
    (next.teacherFeedback ?? "") !== (answer.teacherFeedback ?? "");
  const copy = answers.map(toPlainAnswer);
  copy[index] = next;
  return { ok: true, answers: copy, changed };
}

