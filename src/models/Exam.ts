import { Schema, model, Document } from "mongoose";

export interface IExam extends Document {
  studentId: Schema.Types.ObjectId;
  subject: string;
  lessonRef?: string;
  title: string;
  grade: number;
  maxGrade: number;
  date: Date;
}

const examSchema = new Schema<IExam>(
  {
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true, trim: true },
    lessonRef: { type: String },
    title: { type: String, required: true, trim: true },
    grade: { type: Number, required: true, min: 0 },
    maxGrade: { type: Number, required: true, min: 1 },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const Exam = model<IExam>("Exam", examSchema);