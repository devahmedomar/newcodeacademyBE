import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/User";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";
import { seedTeacher, seedAnnouncements } from "../config/seed";

const signToken = (id: string) =>
  jwt.sign({ sub: id }, process.env.JWT_SECRET || "dev-secret", { expiresIn: "7d" });

export async function login(req: Request, res: Response) {
  try {
    await connectDB();
    await seedTeacher();
    await seedAnnouncements();

    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.active) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = signToken(user.id);
    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

export async function register(req: AuthRequest, res: Response) {
  try {
    await connectDB();

    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "All fields required" });
    if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: "Email already registered" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, role: "student", passwordHash });

    return res.status(201).json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("register error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

export async function changePassword(req: AuthRequest, res: Response) {
  try {
    await connectDB();

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const user = req.user!;
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(401).json({ message: "Current password is incorrect" });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res.json({ message: "Password updated" });
  } catch (err) {
    console.error("change password error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

export async function me(req: AuthRequest, res: Response) {
  return res.json({
    user: {
      id: req.user!.id,
      name: req.user!.name,
      email: req.user!.email,
      role: req.user!.role,
      enrollmentDate: req.user!.enrollmentDate,
    },
  });
}