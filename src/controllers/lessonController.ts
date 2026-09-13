import { Response } from "express";
import { Lesson, extractYoutubeId } from "../models/Lesson";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";

export async function list(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const q = req.user!.role === "teacher" ? {} : { published: true };
    const lessons = await Lesson.find(q).sort({ module: 1, order: 1 });
    res.json(lessons);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { title, description, youtubeVideoId, order, module, published } = req.body;
    if (!title || !youtubeVideoId || order === undefined || !module) {
      return res.status(400).json({ message: "Title, YouTube ID, order and module required" });
    }
    const lesson = await Lesson.create({
      title,
      description,
      youtubeVideoId: extractYoutubeId(youtubeVideoId),
      order,
      module,
      published,
    });
    res.status(201).json(lesson);
  } catch (err: any) {
    if (err?.code === 11000) return res.status(409).json({ message: "Order already used in this module" });
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const body = { ...req.body };
    if (body.youtubeVideoId) body.youtubeVideoId = extractYoutubeId(body.youtubeVideoId);
    const lesson = await Lesson.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true });
    if (!lesson) return res.status(404).json({ message: "Lesson not found" });
    res.json(lesson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const lesson = await Lesson.findByIdAndDelete(req.params.id);
    if (!lesson) return res.status(404).json({ message: "Lesson not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}