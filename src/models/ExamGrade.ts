import { Schema, model, Document } from "mongoose";

export interface IExamGrade extends Document {
  examId: Schema.Types.ObjectId;
  studentId: Schema.Types.ObjectId;
  grade: number;
}

const examGradeSchema = new Schema<IExamGrade>(
  {
    examId: { type: Schema.Types.ObjectId, ref: "ExamTemplate", required: true, index: true },
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    grade: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

examGradeSchema.index({ examId: 1, studentId: 1 }, { unique: true });

export const ExamGrade = model<IExamGrade>("ExamGrade", examGradeSchema);