import { sanitizeModelText } from "../ai/validate";
import type { IBlueprintTopic } from "../../models/ExamSet";
import type { IExamQuestion } from "../../models/ExamForm";

/**
 * Turns raw model output into `ExamQuestion` documents.
 *
 * Everything in this file is pure: no database, no network, no clock. That keeps
 * the awkward parts of AI generation — turning `correctIndex` into a stable id,
 * rejecting a question with three options, spotting a question that repeats one
 * from a sibling form — testable without a Gemini key.
 *
 * The rules are deliberately strict. A form that is one option short, or that
 * silently gains a question, is a fairness problem the teacher would have to
 * catch by eye, so bad questions are dropped and reported instead.
 */

export const MCQ_OPTION_COUNT = 4;
export const MIN_SHORT_POINTS = 2;
export const MAX_SHORT_POINTS = 5;
export const FORM_LABELS = ["A", "B", "C", "D"] as const;
export const MIN_FORMS = 2;
export const MAX_FORMS = 4;

export type FormLabel = (typeof FORM_LABELS)[number];

export interface BuiltOption {
  id: string;
  text: string;
}

export interface BuiltQuestion {
  type: "mcq" | "short";
  prompt: string;
  options: BuiltOption[];
  correctOptionId?: string;
  modelAnswer?: string;
  rubric: string[];
  maxPoints: number;
  explanation: string;
  topic: string;
  sourcePages: number[];
  editedByTeacher: boolean;
  verify: { status: "pending" | "ok" | "repaired" | "flagged"; issue: VerifyIssue; note: string };
}

export type VerifyIssue =
  | "none"
  | "ambiguous"
  | "multiple_correct"
  | "not_in_source"
  | "bad_distractor";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function coerceDifficulty(value: unknown): "easy" | "medium" | "hard" {
  return value === "easy" || value === "hard" ? value : "medium";
}

/** `'A' | 'B' | 'C' | 'D'` for the requested number of forms. */
export function formLabels(count: number): FormLabel[] {
  const n = clampInt(count, MIN_FORMS, MAX_FORMS, MIN_FORMS);
  return FORM_LABELS.slice(0, n) as unknown as FormLabel[];
}

export function isFormLabel(value: unknown): value is FormLabel {
  return typeof value === "string" && (FORM_LABELS as readonly string[]).includes(value.toUpperCase());
}

export function optionId(index: number): string {
  return `o${index + 1}`;
}

/**
 * Fold a string down to a comparable shape: strip Arabic diacritics and
 * tatweel, unify Arabic-Indic digits, drop punctuation, collapse whitespace.
 * Used only for duplicate detection, never for display.
 */
export function normalizeForCompare(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate for prompts and logs without cutting a word in half. */
export function clip(text: string, max = 160): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/* -------------------------------------------------------------------------- */
/* Building one question                                                       */
/* -------------------------------------------------------------------------- */

export interface RejectedQuestion {
  index: number;
  reason: string;
}

export type BuildOutcome =
  | { ok: true; question: BuiltQuestion }
  | { ok: false; reason: string };

export interface BuildContext {
  /** Only pages inside the set's range are accepted in `sourcePages`. */
  pageFrom: number;
  pageTo: number;
  /** Blueprint topic names, used to snap a near-miss `topic` onto a real one. */
  topics?: string[];
  /**
   * Option ids to reuse, position by position, instead of minting `o1`..`o4`.
   * Set by the teacher-edit path so reordering a list moves the ids with the
   * text and the answer key keeps pointing at the right option.
   */
  preserveOptionIds?: string[];
}

function readString(value: unknown): string {
  if (typeof value !== "string") return "";
  return sanitizeModelText(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => readString(v))
    .filter((s) => s.length > 0);
}

/**
 * Snap a model-supplied topic onto a blueprint topic.
 *
 * The model is told to copy the topic name verbatim, but it rephrases often
 * enough that coverage parity would silently break if we stored what it said.
 */
export function resolveTopic(raw: unknown, topics: string[] = []): string {
  const said = readString(raw);
  if (!said) return topics[0] ?? "";

  const target = normalizeForCompare(said);
  for (const t of topics) {
    if (normalizeForCompare(t) === target) return t;
  }
  for (const t of topics) {
    const other = normalizeForCompare(t);
    if (other && (target.includes(other) || other.includes(target))) return t;
  }
  return said;
}

function buildSourcePages(raw: unknown, ctx: BuildContext): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const v of raw) {
    const n = Math.trunc(Number(v));
    if (!Number.isInteger(n)) continue;
    if (n < ctx.pageFrom || n > ctx.pageTo) continue;
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Convert one raw model question into a persistable one, or explain why it is
 * unusable. `raw` is intentionally `unknown` — the model is an untrusted source
 * and the JSON schema is a request, not a guarantee.
 */
export function buildQuestion(raw: unknown, ctx: BuildContext): BuildOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const q = raw as Record<string, unknown>;

  const prompt = readString(q.prompt);
  if (prompt.length < 8) return { ok: false, reason: "empty or truncated prompt" };

  const type = q.type === "short" ? "short" : "mcq";
  const topics = ctx.topics ?? [];
  const base = {
    prompt,
    topic: resolveTopic(q.topic, topics),
    sourcePages: buildSourcePages(q.sourcePages, ctx),
    explanation: readString(q.explanation),
    editedByTeacher: false,
    verify: { status: "pending", issue: "none", note: "" } as BuiltQuestion["verify"],
  };

  if (type === "mcq") {
    const texts = readStringArray(q.options);
    if (texts.length !== MCQ_OPTION_COUNT) {
      return { ok: false, reason: `expected ${MCQ_OPTION_COUNT} options, got ${texts.length}` };
    }

    // Duplicate distractors make the question unanswerable, so drop it rather
    // than letting a near-duplicate pair survive.
    const normalised = texts.map(normalizeForCompare);
    if (new Set(normalised).size !== normalised.length) {
      return { ok: false, reason: "duplicate option text" };
    }

    const correctIndex = Math.trunc(Number(q.correctIndex));
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= texts.length) {
      return { ok: false, reason: `correctIndex ${String(q.correctIndex)} is out of range` };
    }

    return {
      ok: true,
      question: {
        ...base,
        type: "mcq",
        options: texts.map((text, i) => ({ id: ctx.preserveOptionIds?.[i] ?? optionId(i), text })),
        correctOptionId: ctx.preserveOptionIds?.[correctIndex] ?? optionId(correctIndex),
        rubric: [],
        maxPoints: 1,
      },
    };
  }

  const modelAnswer = readString(q.modelAnswer);
  if (!modelAnswer) return { ok: false, reason: "short answer has no model answer" };

  const rubric = readStringArray(q.rubric);
  if (rubric.length === 0) return { ok: false, reason: "short answer has no rubric" };
  if (new Set(rubric.map(normalizeForCompare)).size !== rubric.length) {
    return { ok: false, reason: "rubric repeats the same point" };
  }

  return {
    ok: true,
    question: {
      ...base,
      type: "short",
      options: [],
      // The rubric carries the marks, so the point value follows it rather than
      // whatever number the model felt like writing.
      rubric,
      maxPoints: clampInt(rubric.length, MIN_SHORT_POINTS, MAX_SHORT_POINTS, MIN_SHORT_POINTS),
      modelAnswer,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Building a whole form                                                       */
/* -------------------------------------------------------------------------- */

export interface BuiltForm {
  questions: BuiltQuestion[];
  rejected: RejectedQuestion[];
  /** Questions dropped because a sibling form already used the same wording. */
  duplicates: number;
}

export interface BuildFormOptions extends BuildContext {
  mcqCount: number;
  shortCount: number;
  /** Prompts already used by sibling forms; used to enforce cross-form variety. */
  alreadyUsed?: string[];
}

export function buildForm(rawQuestions: unknown, opts: BuildFormOptions): BuiltForm {
  const list = Array.isArray(rawQuestions) ? rawQuestions : [];
  const used = new Set((opts.alreadyUsed ?? []).map(normalizeForCompare));
  const seenHere = new Set<string>();
  const accepted: BuiltQuestion[] = [];
  const rejected: RejectedQuestion[] = [];
  let duplicates = 0;

  list.forEach((raw, index) => {
    const outcome = buildQuestion(raw, opts);
    if (!outcome.ok) {
      rejected.push({ index, reason: outcome.reason });
      return;
    }
    const fingerprint = normalizeForCompare(outcome.question.prompt);
    if (used.has(fingerprint) || seenHere.has(fingerprint)) {
      duplicates++;
      rejected.push({ index, reason: "duplicate of a question already in use" });
      return;
    }
    seenHere.add(fingerprint);
    accepted.push(outcome.question);
  });

  return { questions: orderQuestions(accepted), rejected, duplicates };
}

/** MCQ block first, then short answers. A stable canonical order for the review UI. */
export function orderQuestions(questions: BuiltQuestion[]): BuiltQuestion[] {
  return [
    ...questions.filter((q) => q.type === "mcq"),
    ...questions.filter((q) => q.type === "short"),
  ];
}

export interface ReconcileResult {
  questions: BuiltQuestion[];
  /** Extra questions discarded to hit the requested counts. */
  trimmed: number;
  missing: { mcq: number; short: number };
}

/**
 * Force the form to exactly `mcqCount` + `shortCount` questions by dropping the
 * surplus. A shortfall is reported rather than padded — a form quietly missing a
 * question is worse than one the teacher regenerates.
 */
export function reconcileCounts(
  questions: BuiltQuestion[],
  opts: { mcqCount: number; shortCount: number }
): ReconcileResult {
  const mcq = questions.filter((q) => q.type === "mcq");
  const short = questions.filter((q) => q.type === "short");

  const keptMcq = mcq.slice(0, Math.max(0, opts.mcqCount));
  const keptShort = short.slice(0, Math.max(0, opts.shortCount));

  return {
    questions: orderQuestions([...keptMcq, ...keptShort]),
    trimmed: mcq.length - keptMcq.length + (short.length - keptShort.length),
    missing: {
      mcq: Math.max(0, opts.mcqCount - keptMcq.length),
      short: Math.max(0, opts.shortCount - keptShort.length),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Review helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Project a stored question back into the raw shape the model speaks.
 *
 * Used twice: to feed the verify prompt (which speaks the same dialect the
 * generator does, `correctIndex` included) and to let a teacher edit run through
 * exactly the same validation as generated output, so a hand-written question
 * cannot bypass the four-options-one-correct rule.
 */
export function toRawQuestion(question: {
  type: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId?: string;
  modelAnswer?: string;
  rubric: string[];
  maxPoints: number;
  topic: string;
  sourcePages: number[];
}): Record<string, unknown> {
  const base = {
    type: question.type,
    prompt: question.prompt,
    topic: question.topic,
    sourcePages: question.sourcePages,
  };
  if (question.type !== "mcq") {
    return { ...base, modelAnswer: question.modelAnswer ?? "", rubric: question.rubric };
  }
  const options = (question.options ?? []).map((o) => o.text);
  return {
    ...base,
    options,
    correctIndex: (question.options ?? []).findIndex((o) => o.id === question.correctOptionId),
  };
}

export interface TeacherEdit {
  prompt?: string;
  /** Either plain strings or `{ id, text }` pairs; bare strings get fresh ids. */
  options?: Array<string | { id?: string; text?: string }>;
  /**
   * Which option is correct. `correctOptionId` works when the incoming entries
   * carry the ids the form already has; `correctIndex` is for a list of bare
   * strings, where the caller has no ids to refer to yet.
   */
  correctOptionId?: string;
  correctIndex?: number;
  modelAnswer?: string;
  rubric?: string[];
  maxPoints?: number;
  explanation?: string;
  topic?: string;
  sourcePages?: number[];
}

export type EditOutcome = { ok: true; question: BuiltQuestion } | { ok: false; error: string };

/**
 * Merge a teacher's changes into an existing question and re-validate the whole
 * thing. Re-using `buildQuestion` is the point: an edit is no more trustworthy
 * than generated output, so it faces the same four-options-one-correct rule.
 */
export function applyTeacherEdit(
  existing: {
    type: string;
    prompt: string;
    options: Array<{ id: string; text: string }>;
    correctOptionId?: string;
    modelAnswer?: string;
    rubric: string[];
    maxPoints: number;
    topic: string;
    sourcePages: number[];
  },
  edit: TeacherEdit,
  ctx: BuildContext
): EditOutcome {
  const raw = toRawQuestion(existing);
  let preserveOptionIds: string[] | undefined;

  if (edit.prompt !== undefined) raw.prompt = edit.prompt;
  if (edit.topic !== undefined) raw.topic = edit.topic;
  if (edit.explanation !== undefined) raw.explanation = edit.explanation;
  if (edit.modelAnswer !== undefined) raw.modelAnswer = edit.modelAnswer;
  if (edit.rubric !== undefined) raw.rubric = edit.rubric;
  if (edit.sourcePages !== undefined) raw.sourcePages = edit.sourcePages;
  if (edit.maxPoints !== undefined) raw.maxPoints = edit.maxPoints;

  if (Array.isArray(edit.options)) {
    const rebuilt = rebuildOptions(existing, edit.options, {
      correctOptionId: edit.correctOptionId,
      correctIndex: edit.correctIndex,
    });
    if (!rebuilt.ok) return { ok: false, error: rebuilt.error };

    raw.options = rebuilt.options.map((o) => o.text);
    raw.correctIndex = rebuilt.options.findIndex((o) => o.id === rebuilt.correctOptionId);
    // Carry the resolved ids into validation, otherwise `buildQuestion` would
    // renumber by position and a reordered list would move the answer key.
    preserveOptionIds = rebuilt.options.map((o) => o.id);
  } else if (edit.correctOptionId !== undefined && existing.type === "mcq") {
    const index = (existing.options ?? []).findIndex((o) => o.id === edit.correctOptionId);
    if (index < 0) return { ok: false, error: "correctOptionId is not one of this question's options" };
    raw.correctIndex = index;
  }

  const outcome = buildQuestion(raw, { ...ctx, preserveOptionIds });
  if (!outcome.ok) return { ok: false, error: outcome.reason };

  return {
    ok: true,
    question: {
      ...outcome.question,
      // A hand-written question has already been reviewed by a human.
      verify: { status: "ok", issue: "none", note: "Edited by the teacher" },
    },
  };
}

export type RebuiltOptions =
  | { ok: true; options: BuiltOption[]; correctOptionId: string }
  | { ok: false; error: string };

/**
 * Re-key an option list after a teacher edits the texts.
 *
 * An option keeps its id when the incoming entry names it, and otherwise when its
 * text still matches one the question already had — that is what makes a reorder
 * safe: the id travels with the text, so the answer key follows the option rather
 * than the slot. Ids the question never had get the next free `oN`.
 *
 * Returns an error rather than guessing when the correct answer cannot be
 * resolved, which is the case when every text was replaced and the client did not
 * say which one is right.
 */
export function rebuildOptions(
  existing:
    | { options: Array<{ id: string; text?: string }>; correctOptionId?: string }
    | undefined,
  incoming: Array<string | { id?: string; text?: string }>,
  /**
   * How the caller names the correct answer: by id when the incoming entries
   * carry the ids the form already has, by position when they are bare strings
   * and no ids exist yet. Falls back to the key already on the question.
   */
  answer: { correctOptionId?: string; correctIndex?: number } = {}
): RebuiltOptions {
  const known = new Set((existing?.options ?? []).map((o) => o.id));

  const byText = new Map<string, string>();
  for (const o of existing?.options ?? []) {
    const key = normalizeForCompare(o.text ?? "");
    if (key && !byText.has(key)) byText.set(key, o.id);
  }

  const used = new Set<string>();
  const options: BuiltOption[] = [];

  incoming.forEach((entry, index) => {
    const declared = typeof entry === "string" ? undefined : entry?.id?.trim() || undefined;
    const text = typeof entry === "string" ? entry : String(entry?.text ?? "");
    const byExistingText = byText.get(normalizeForCompare(text));

    const id =
      declared && known.has(declared) && !used.has(declared)
        ? declared
        : byExistingText && !used.has(byExistingText)
          ? byExistingText
          : nextFreeOptionId(used, index);

    used.add(id);
    options.push({ id, text });
  });

  if (options.length === 0) return { ok: false, error: "A multiple-choice question needs at least one option" };

  // An explicit position that does not exist is a client bug, not something to
  // paper over by falling back to the old key.
  if (answer.correctIndex !== undefined) {
    const i = answer.correctIndex;
    if (!Number.isInteger(i) || i < 0 || i >= options.length) {
      return { ok: false, error: "correctIndex is out of range for the options sent" };
    }
  }

  const byPosition = Number.isInteger(answer.correctIndex)
    ? options[answer.correctIndex as number].id
    : undefined;
  const wanted = answer.correctOptionId ?? byPosition ?? existing?.correctOptionId;
  const resolved = wanted ? options.find((o) => o.id === wanted)?.id : undefined;
  if (!resolved) return { ok: false, error: "Mark which option is the correct answer" };

  return { ok: true, options, correctOptionId: resolved };
}

function nextFreeOptionId(used: Set<string>, index: number): string {
  let n = index;
  let id = optionId(n);
  while (used.has(id)) {
    n += 1;
    id = optionId(n);
  }
  return id;
}

export function maxGradeOf(questions: Array<{ maxPoints: number }>): number {
  return questions.reduce((sum, q) => sum + (Number(q.maxPoints) || 0), 0);
}

export interface CoverageReport {
  covered: string[];
  /** Blueprint topics that no question in this form touches. */
  missing: string[];
  /** Questions tagged with something that is not a blueprint topic. */
  offMap: string[];
}

/**
 * Compare a form against the blueprint. Every weight-3 topic must appear in at
 * least one form, otherwise students on different papers are not being tested on
 * the same ground.
 */
export function coverageOf(
  questions: Array<{ topic: string }>,
  topics: IBlueprintTopic[]
): CoverageReport {
  const used = new Set(questions.map((q) => normalizeForCompare(q.topic)));
  const covered: string[] = [];
  const missing: string[] = [];

  for (const t of topics) {
    if (used.has(normalizeForCompare(t.topic))) covered.push(t.topic);
    else missing.push(t.topic);
  }

  const known = new Set(topics.map((t) => normalizeForCompare(t.topic)));
  const offMap: string[] = [];
  for (const q of questions) {
    const key = normalizeForCompare(q.topic);
    if (key && !known.has(key) && !offMap.includes(q.topic)) offMap.push(q.topic);
  }

  return { covered, missing, offMap };
}

/** The `alreadyUsed` payload the next form's prompt receives. */
export function usedPromptList(forms: Array<{ questions: IExamQuestion[] }>): string[] {
  return forms
    .flatMap((f) => f.questions.map((q) => q.prompt))
    .filter((p) => typeof p === "string" && p.trim().length > 0);
}
