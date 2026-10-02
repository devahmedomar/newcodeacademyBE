import { Schema, model, Document } from "mongoose";

/**
 * One sitting of one paper.
 *
 * The shuffle lives on the attempt, not on the form. That is the whole reason this
 * document exists rather than a score row: `questionOrder` and `optionOrder` are
 * persisted the moment the paper is opened, so the review screen, a retry, a teacher
 * override and a disputed grade all refer to the exact paper the student saw. A
 * shuffle recomputed on demand would show a student a different paper on their
 * results page than the one they answered.
 */

export type AttemptStatus = "draft" | "submitted" | "graded" | "grading_failed";
export type AnswerType = "mcq" | "short";
export type Confidence = "high" | "medium" | "low";

export interface IAttemptAnswer {
  questionId: Schema.Types.ObjectId;
  type: AnswerType;
  /** MCQ only, and always the option's stable id — never a position. */
  chosenOptionId?: string;
  isCorrect?: boolean;
  /** Short only. */
  textAnswer?: string;
  /** Set once the AI has looked at a short answer. */
  aiScore?: number;
  aiMax?: number;
  aiFeedback?: string;
  aiConfidence?: Confidence;
  /** A teacher overriding the AI is a separate fact from the AI's own opinion. */
  teacherScore?: number;
  teacherFeedback?: string;
  overriddenBy?: Schema.Types.ObjectId;
  overriddenAt?: Date;
}

export interface IExamAttempt extends Document {
  examSetId: Schema.Types.ObjectId;
  formId: Schema.Types.ObjectId;
  studentId: Schema.Types.ObjectId;
  /** Question ids in the order this student saw them. */
  questionOrder: Schema.Types.ObjectId[];
  /** Option ids per question, in the order this student saw them. */
  optionOrder: Map<string, string[]>;
  answers: IAttemptAnswer[];
  status: AttemptStatus;
  mcqScore: number;
  shortScore: number;
  totalScore: number;
  maxGrade: number;
  percent: number;
  /** True when any short answer is still waiting for a teacher. */
  needsReview: boolean;
  submittedAt?: Date;
  gradedAt?: Date;
  /** The set's time limit, copied in so a resumed draft still knows the deadline. */
  timeLimitMinutes?: number;
  /** A draft expires on its own; a submitted attempt never does. */
  draftSavedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const attemptAnswerSchema = new Schema<IAttemptAnswer>(
  {
    questionId: { type: Schema.Types.ObjectId, ref: "ExamForm.questions", required: true },
    type: { type: String, enum: ["mcq", "short"], required: true },
    chosenOptionId: { type: String },
    isCorrect: Boolean,
    textAnswer: { type: String, default: "" },
    aiScore: Number,
    aiMax: Number,
    aiFeedback: String,
    aiConfidence: { type: String, enum: ["high", "medium", "low"] },
    teacherScore: Number,
    teacherFeedback: String,
    overriddenBy: { type: Schema.Types.ObjectId, ref: "User" },
    overriddenAt: { type: Date },
  },
  { _id: false }
);

const examAttemptSchema = new Schema<IExamAttempt>(
  {
    examSetId: { type: Schema.Types.ObjectId, ref: "ExamSet", required: true, index: true },
    formId: { type: Schema.Types.ObjectId, ref: "ExamForm", required: true },
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // An array of ObjectIds is not a Mapped type, so this is stored as a map of
    // arrays explicitly rather than relying on inference.
    questionOrder: { type: [Schema.Types.ObjectId], required: true },
    optionOrder: { type: Map, of: [String], default: () => new Map<string, string[]>() },
    answers: { type: [attemptAnswerSchema], default: [] },
    status: { type: String, enum: ["draft", "submitted", "graded", "grading_failed"], default: "draft", index: true },
    mcqScore: { type: Number, default: 0 },
    shortScore: { type: Number, default: 0 },
    totalScore: { type: Number, default: 0 },
    maxGrade: { type: Number, default: 0 },
    percent: { type: Number, default: 0, min: 0, max: 100 },
    needsReview: { type: Boolean, default: false },
    submittedAt: { type: Date },
    gradedAt: { type: Date },
    timeLimitMinutes: Number,
    draftSavedAt: { type: Date },
  },
  { timestamps: true }
);

// "My attempts on this set", and the attempt cap check, both run off this.
examAttemptSchema.index({ examSetId: 1, studentId: 1, createdAt: -1 });

// A student gets one live draft at a time per set. Submitted attempts are not
// drafts, so the partial index below lets a student retry without a second draft.
examAttemptSchema.index(
  { examSetId: 1, studentId: 1 },
  { unique: true, partialFilterExpression: { status: "draft" } }
);

export const ExamAttempt = model<IExamAttempt>("ExamAttempt", examAttemptSchema);
