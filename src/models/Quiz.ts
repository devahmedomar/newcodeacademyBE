import { Schema, model, Document } from "mongoose";

export interface IQuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
}

export interface IQuiz extends Document {
  lessonId: Schema.Types.ObjectId;
  questions: IQuizQuestion[];
}

const quizSchema = new Schema<IQuiz>(
  {
    lessonId: { type: Schema.Types.ObjectId, ref: "Lesson", required: true, unique: true },
    questions: {
      type: [
        {
          question: { type: String, required: true, trim: true },
          options: {
            type: [String],
            required: true,
            validate: {
              validator: (v: string[]) =>
                Array.isArray(v) && v.length >= 2 && v.length <= 6 && v.every((o) => o.trim().length > 0),
              message: "Each question needs 2 to 6 non-empty options",
            },
          },
          correctIndex: { type: Number, required: true, min: 0 },
        },
      ],
      required: true,
      validate: {
        validator: (v: IQuizQuestion[]) => Array.isArray(v) && v.length >= 1,
        message: "A quiz needs at least one question",
      },
    },
  },
  { timestamps: true }
);

quizSchema.index({ lessonId: 1 }, { unique: true });

export const Quiz = model<IQuiz>("Quiz", quizSchema);