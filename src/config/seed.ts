import bcrypt from "bcryptjs";
import { User } from "../models/User";
import { Announcement } from "../models/Announcement";

export async function seedTeacher() {
  const teacherEmail = process.env.SEED_TEACHER_EMAIL?.toLowerCase();
  if (!teacherEmail) return;

  const exists = await User.findOne({ email: teacherEmail });
  if (exists) return;

  const passwordHash = await bcrypt.hash(process.env.SEED_TEACHER_PASSWORD || "ChangeMe123!", 10);
  await User.create({
    name: process.env.SEED_TEACHER_NAME || "Teacher",
    email: teacherEmail,
    passwordHash,
    role: "teacher",
  });
  console.log("Seeded initial teacher account:", teacherEmail);
}

export async function seedAnnouncements() {
  const count = await Announcement.countDocuments();
  if (count > 0) return;

  const teacher = await User.findOne({ role: "teacher" }).sort({ createdAt: 1 });
  const teacherId = teacher ? teacher._id : undefined;

  await Announcement.create([
    {
      teacherId,
      title: "🎉 Welcome to the portal!",
      body:
        "We're glad you're here. Watch your first lesson to start a streak, and check your profile for badges you can earn. Let's learn!",
      pinned: true,
    },
    {
      teacherId,
      title: "Weekly goal",
      body: "Try to complete at least 5 lessons every week to keep your streak alive. Your progress shows on your profile.",
    },
  ]);
  console.log("Seeded sample announcements");
}