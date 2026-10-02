import { Schema, model, Document } from "mongoose";

/**
 * The container for one weekly AI-generated exam.
 *
 * A set owns the generation parameters (page range, difficulty, counts) and the
 * blueprint that all of its forms are built from. The forms themselves live in
 * `ExamForm` documents because they are large and are edited independently.
 */

export type ExamDifficulty = "easy" | "medium" | "hard";
export type ExamSetStatus = "draft" | "published" | "closed";

export interface IBlueprintTopic {
  topic: string;
  /** 1..3 — 3 means a core axis of the range. */
  weight: number;
  keywords: string[];
}

export interface IExamSetBlueprint {
  topics: IBlueprintTopic[];
  summary: string;
  createdAt: Date;
}

export interface IExamSet extends Document {
  teacherId: Schema.Types.ObjectId;
  bookId: Schema.Types.ObjectId;
  title: string;
  weekLabel?: string;
  lessonRef?: string;
  /** 1-based inclusive page bounds inside the book. */
  pageFrom: number;
  pageTo: number;
  difficulty: ExamDifficulty;
  mcqCount: number;
  shortCount: number;
  /** Number of distinct papers to build, 2..4. */
  formCount: number;
  /** Run the verify + repair pass after every form. */
  verifyOnGenerate: boolean;
  timeLimitMinutes?: number;
  passPercent: number;
  maxAttempts: number;
  status: ExamSetStatus;
  openUntil?: Date;
  /** Set when the set is published; cleared by `PATCH /status` back to draft. */
  publishedAt?: Date;
  /** Present once `POST /blueprint` has run. */
  blueprint?: IExamSetBlueprint;
  createdAt: Date;
  updatedAt: Date;
}

const topicSchema = new Schema<IBlueprintTopic>(
  {
    topic: { type: String, required: true, trim: true },
    weight: { type: Number, required: true, min: 1, max: 3 },
    keywords: { type: [String], default: [] },
  },
  { _id: false }
);

const examSetSchema = new Schema<IExamSet>(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    bookId: { type: Schema.Types.ObjectId, ref: "Book", required: true, index: true },
    title: { type: String, required: true, trim: true },
    weekLabel: { type: String, trim: true },
    lessonRef: { type: String, trim: true },
    pageFrom: { type: Number, required: true, min: 1 },
    pageTo: { type: Number, required: true, min: 1 },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
    mcqCount: { type: Number, required: true, min: 0, max: 20, default: 8 },
    shortCount: { type: Number, required: true, min: 0, max: 10, default: 2 },
    formCount: { type: Number, required: true, min: 2, max: 4, default: 3 },
    verifyOnGenerate: { type: Boolean, default: true },
    timeLimitMinutes: { type: Number, min: 1, max: 300 },
    passPercent: { type: Number, required: true, min: 0, max: 100, default: 50 },
    maxAttempts: { type: Number, required: true, min: 1, max: 10, default: 1 },
    status: { type: String, enum: ["draft", "published", "closed"], default: "draft", index: true },
    openUntil: { type: Date },
    publishedAt: { type: Date },
    blueprint: {
      topics: { type: [topicSchema], default: [] },
      summary: { type: String, default: "" },
      createdAt: { type: Date },
    },
  },
  { timestamps: true }
);

// The list screen is always "this teacher's sets, newest first".
examSetSchema.index({ teacherId: 1, createdAt: -1 });

export const ExamSet = model<IExamSet>("ExamSet", examSetSchema);
