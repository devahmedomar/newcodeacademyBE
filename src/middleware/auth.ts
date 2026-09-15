import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { User, IUser } from "../models/User";
import { connectDB } from "../config/db";

export interface AuthRequest extends Request {
  user?: IUser;
}

export async function authGuard(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authorization header missing" });
  }

  const token = header.slice(7);
  let payload: { sub: string };
  try {
    const secret = process.env.JWT_SECRET || "dev-secret";
    payload = jwt.verify(token, secret) as { sub: string };
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  try {
    await connectDB();
    const user = await User.findById(payload.sub);
    if (!user || !user.active) return res.status(401).json({ message: "User not found or inactive" });
    req.user = user;
    next();
  } catch (err) {
    console.error("authGuard db error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}

export function roleGuard(...roles: Array<"student" | "teacher">) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}