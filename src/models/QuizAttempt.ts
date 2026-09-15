import { Schema, model, Document } from "mongoose";

export interface IQuizAnswer {
  question: string;
  chosen: number;
  correct: number;
}

export interface IQuizAttempt extends Document {
  quizId: Schema.Types.ObjectId;
  studentId: Schema.Types.ObjectId;
  score: number;
  total: number;
  percent: number;
  answers: IQuizAnswer[];
}

const quizAttemptSchema = new Schema<IQuizAttempt>(
  {
    quizId: { type: Schema.Types.ObjectId, ref: "Quiz", required: true, index: true },
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    score: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 1 },
    percent: { type: Number, required: true, min: 0, max: 100 },
    answers: {
      type: [
        {
          question: { type: String, required: true },
          chosen: { type: Number, required: true, min: 0 },
          correct: { type: Number, required: true, min: 0 },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

quizAttemptSchema.index({ quizId: 1, studentId: 1 });

export const QuizAttempt = model<IQuizAttempt>("QuizAttempt", quizAttemptSchema);