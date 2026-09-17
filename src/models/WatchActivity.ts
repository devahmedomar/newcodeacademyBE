import { Schema, model, Document } from "mongoose";

export interface IWatchActivity extends Document {
  studentId: Schema.Types.ObjectId;
  lessonId: Schema.Types.ObjectId;
  date: string;
  watchedAt: Date;
}

const watchActivitySchema = new Schema<IWatchActivity>(
  {
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lessonId: { type: Schema.Types.ObjectId, ref: "Lesson", required: true },
    date: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

watchActivitySchema.index({ studentId: 1, date: 1 });
watchActivitySchema.index({ studentId: 1, lessonId: 1 });

export const WatchActivity = model<IWatchActivity>("WatchActivity", watchActivitySchema);