import { Schema, model, Document } from "mongoose";

export interface ILesson extends Document {
  title: string;
  description?: string;
  youtubeVideoId: string;
  order: number;
  module: string;
  published: boolean;
  uploadDate: Date;
}

const lessonSchema = new Schema<ILesson>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String },
    youtubeVideoId: { type: String, required: true, trim: true },
    order: { type: Number, required: true, min: 0 },
    module: { type: String, required: true, trim: true },
    published: { type: Boolean, default: true },
    uploadDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

lessonSchema.index({ module: 1, order: 1 }, { unique: true });

export const Lesson = model<ILesson>("Lesson", lessonSchema);

export function extractYoutubeId(input: string): string {
  const trimmed = input.trim();
  const patterns = [
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return m[1];
  }
  return trimmed;
}