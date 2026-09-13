import bcrypt from "bcryptjs";
import { User } from "../models/User";

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