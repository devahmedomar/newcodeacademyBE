import { Schema, model, Document, Types } from "mongoose";
import { ExamDifficulty } from "./ExamSet";

/**
 * One of the N distinct papers belonging to an `ExamSet`.
 *
 * Questions are embedded because a form is always read and written whole. The
 * crucial detail is that MCQ options carry **stable ids** rather than positions:
 * the existing `Quiz` model stores answers as a positional `number[]`, which makes
 * per-student option shuffling impossible. With ids, the server can hand every
 * student a different option order and still know which option was correct.
 */

export type ExamQuestionType = "mcq" | "short";

export interface IExamOption {
  /** Stable within the question, e.g. `o1`..`o4`. Never reused as an index. */
  id: string;
  text: string;
}

export type VerifyIssue =
  | "none"
  | "ambiguous"
  | "multiple_correct"
  | "not_in_source"
  | "bad_distractor";

export interface IExamQuestionVerify {
  status: "pending" | "ok" | "repaired" | "flagged";
  issue: VerifyIssue;
  note: string;
  checkedAt: Date;
}

export interface IExamQuestion {
  type: ExamQuestionType;
  /** Arabic question text. */
  prompt: string;
  /** MCQ only. Empty for short answers. */
  options: IExamOption[];
  /** MCQ only. References `options[].id`. */
  correctOptionId?: string;
  /** Short answers only — the reference answer the grader checks against. */
  modelAnswer?: string;
  /** Short answers only — the bullet points that carry the marks. */
  rubric: string[];
  /** MCQ is always 1; short answers are 2..5. */
  maxPoints: number;
  /** Arabic, shown to the student after submitting. */
  explanation: string;
  /** Blueprint topic key, so coverage across forms can be compared. */
  topic: string;
  /** 1-based book page numbers this question came from. */
  sourcePages: number[];
  /** True once a teacher has touched the question by hand. */
  editedByTeacher: boolean;
  verify: IExamQuestionVerify;
}

export type ExamFormStatus = "generating" | "draft" | "ready";

/**
 * A question as it exists inside a stored form: the plain shape above plus the
 * Mongo subdocument. Review routes address a single question by `_id`, so it has
 * to be part of the type rather than reached through a cast.
 */
export interface IExamQuestionDoc extends IExamQuestion, Document {
  _id: Types.ObjectId;
}

export interface IExamForm extends Document {
  examSetId: Schema.Types.ObjectId;
  /** 'A' | 'B' | 'C' | 'D' — matches the UI tab and the assignment record. */
  formLabel: string;
  /** A document array: review code needs `.id()`, `.pull()` and per-question `.set()`. */
  questions: Types.DocumentArray<IExamQuestionDoc>;
  /** Sum of `questions[].maxPoints`, recomputed on every write. */
  maxGrade: number;
  status: ExamFormStatus;
  /** Set when a verify pass has run over the whole form. */
  verifiedAt?: Date;
  /**
   * Set when a teacher says they have read the form.
   *
   * Publishing requires this. The verification pass is a machine check, not a
   * human one, and the plan's answer to "Gemini marked the wrong option" is that
   * nobody is ever handed a paper no teacher has looked at.
   */
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const verifySchema = new Schema<IExamQuestionVerify>(
  {
    status: {
      type: String,
      enum: ["pending", "ok", "repaired", "flagged"],
      default: "pending",
    },
    issue: {
      type: String,
      enum: ["none", "ambiguous", "multiple_correct", "not_in_source", "bad_distractor"],
      default: "none",
    },
    note: { type: String, default: "" },
    checkedAt: { type: Date },
  },
  { _id: false }
);

const optionSchema = new Schema<IExamOption>(
  {
    id: { type: String, required: true },
    text: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const questionSchema = new Schema<IExamQuestion>(
  {
    type: { type: String, enum: ["mcq", "short"], required: true },
    prompt: { type: String, required: true, trim: true },
    options: { type: [optionSchema], default: [] },
    correctOptionId: { type: String },
    modelAnswer: { type: String },
    rubric: { type: [String], default: [] },
    maxPoints: { type: Number, required: true, min: 1, max: 5 },
    explanation: { type: String, default: "" },
    topic: { type: String, default: "" },
    sourcePages: { type: [Number], default: [] },
    editedByTeacher: { type: Boolean, default: false },
    verify: { type: verifySchema, default: () => ({}) },
  },
  { _id: true }
);

const examFormSchema = new Schema<IExamForm>(
  {
    examSetId: { type: Schema.Types.ObjectId, ref: "ExamSet", required: true },
    formLabel: { type: String, required: true, uppercase: true, minlength: 1, maxlength: 1 },
    questions: { type: [questionSchema], default: [] },
    maxGrade: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: ["generating", "draft", "ready"], default: "draft" },
    verifiedAt: { type: Date },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

// One paper per label per set; re-generating a form replaces it in place.
examFormSchema.index({ examSetId: 1, formLabel: 1 }, { unique: true });

export const ExamForm = model<IExamForm>("ExamForm", examFormSchema);

/** Recompute a form's `maxGrade` from its questions. */
export function computeMaxGrade(questions: IExamQuestion[]): number {
  return questions.reduce((sum, q) => sum + (Number(q.maxPoints) || 0), 0);
}

/** Narrowing helper for code that only handles MCQ questions. */
export function isMcq(question: IExamQuestion): boolean {
  return question.type === "mcq";
}

export type { ExamDifficulty };
