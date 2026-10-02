import { Schema, model, Document } from "mongoose";

export interface IBookPage extends Document {
  bookId: Schema.Types.ObjectId;
  /** 1-based, so it matches the page number the teacher sees in the PDF. */
  pageNumber: number;
  text: string;
  charCount: number;
  /** True when this page came from Gemini vision rather than the PDF text layer. */
  transcribed: boolean;
}

const bookPageSchema = new Schema<IBookPage>(
  {
    bookId: { type: Schema.Types.ObjectId, ref: "Book", required: true },
    pageNumber: { type: Number, required: true, min: 1 },
    text: { type: String, default: "" },
    charCount: { type: Number, default: 0, min: 0 },
    transcribed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One document per page keeps page-range reads cheap and keeps any single
// response far below the 4.5 MB serverless limit.
bookPageSchema.index({ bookId: 1, pageNumber: 1 }, { unique: true });

export const BookPage = model<IBookPage>("BookPage", bookPageSchema);
