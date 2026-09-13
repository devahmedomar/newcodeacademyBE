import { Schema, model, Document } from "mongoose";

export interface IExamTemplate extends Document {
  title: string;
  subject: string;
  maxGrade: number;
  date: Date;
  lessonRef?: string;
}

const examTemplateSchema = new Schema<IExamTemplate>(
  {
    title: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    maxGrade: { type: Number, required: true, min: 1 },
    date: { type: Date, default: Date.now },
    lessonRef: { type: String },
  },
  { timestamps: true }
);

export const ExamTemplate = model<IExamTemplate>("ExamTemplate", examTemplateSchema);