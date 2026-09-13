import { Schema, model, Document } from "mongoose";

export interface IHomework extends Document {
  studentId: Schema.Types.ObjectId;
  title: string;
  points: number;
  maxPoints: number;
  submittedAt?: Date;
  feedback?: string;
}

const homeworkSchema = new Schema<IHomework>(
  {
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    points: { type: Number, required: true, min: 0 },
    maxPoints: { type: Number, required: true, min: 1 },
    submittedAt: { type: Date },
    feedback: { type: String },
  },
  { timestamps: true }
);

export const Homework = model<IHomework>("Homework", homeworkSchema);