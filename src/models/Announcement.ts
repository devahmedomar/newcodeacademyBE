import { Schema, model, Document } from "mongoose";

export interface IAnnouncement extends Document {
  teacherId: Schema.Types.ObjectId;
  title: string;
  body: string;
  pinned: boolean;
}

const announcementSchema = new Schema<IAnnouncement>(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Announcement = model<IAnnouncement>("Announcement", announcementSchema);