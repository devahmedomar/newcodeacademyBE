import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";
import { Announcement } from "../models/Announcement";

export async function list(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const announcements = (await Announcement.find().sort({ pinned: -1, createdAt: -1 })) as unknown as Array<{
      _id: unknown;
      title: string;
      body: string;
      pinned: boolean;
      createdAt: Date;
    }>;
    res.json(
      announcements.map((a) => ({
        _id: String(a._id),
        title: a.title,
        body: a.body,
        pinned: a.pinned,
        createdAt: a.createdAt,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { title, body, pinned } = req.body;
    if (!title || typeof title !== "string" || !body || typeof body !== "string") {
      return res.status(400).json({ message: "title and body are required" });
    }
    const announcement = await Announcement.create({
      teacherId: req.user!._id,
      title: title.trim(),
      body: body.trim(),
      pinned: Boolean(pinned),
    });
    res.status(201).json(announcement);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const announcement = await Announcement.findByIdAndDelete(req.params.id);
    if (!announcement) return res.status(404).json({ message: "Announcement not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}