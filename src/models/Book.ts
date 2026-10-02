import { Schema, model, Document } from "mongoose";

export type BookStatus =
  | "extracting"
  /** Text layer was missing; transcription steps are still pending. */
  | "needs_transcription"
  | "ready"
  | "failed";

export interface IBook extends Document {
  teacherId: Schema.Types.ObjectId;
  title: string;
  originalFileName: string;
  pageCount: number;
  language: "ar";
  status: BookStatus;
  ocrUsed: boolean;
  charCount: number;
  sizeBytes: number;
  failureReason?: string;
  extractedAt?: Date;
  /**
   * Highest page number already handed to Gemini vision. Lets transcription run
   * as a series of short requests instead of one long one that would blow the
   * serverless time limit.
   */
  transcribeCursor: number;
  /** Added by the `timestamps: true` option; declared for serialization. */
  createdAt: Date;
  updatedAt: Date;
}

const bookSchema = new Schema<IBook>(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    originalFileName: { type: String, required: true, trim: true },
    pageCount: { type: Number, required: true, min: 1 },
    language: { type: String, enum: ["ar"], default: "ar" },
    status: {
      type: String,
      enum: ["extracting", "needs_transcription", "ready", "failed"],
      default: "extracting",
    },
    // True when the text layer was missing and Gemini vision transcribed the pages.
    ocrUsed: { type: Boolean, default: false },
    charCount: { type: Number, default: 0, min: 0 },
    sizeBytes: { type: Number, required: true, min: 1 },
    failureReason: { type: String },
    extractedAt: { type: Date },
    transcribeCursor: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

bookSchema.index({ teacherId: 1, createdAt: -1 });

export const Book = model<IBook>("Book", bookSchema);
