import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { User } from "../models/User";
import { leaderboardBuckets, percentOf } from "../services/pointsService";
import { connectDB } from "../config/db";

/**
 * This route is reachable without a login: the student portal's public landing
 * page renders the top of the ranking as a marketing feature, and it loads before
 * anyone signs in. So the payload has to be safe to hand to a stranger —
 * anonymous callers get an initial instead of a name, and nobody gets a raw
 * `_id` or a per-student `possible` total. A signed-in caller is a member of the
 * same class and already sees these names in the roster, so they get them here
 * too. See `optionalAuth` on the route.
 */
function maskName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const initial = Array.from(first)[0] ?? "";
  return initial ? `${initial}.` : "•";
}

export async function top(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);

    const acc = await leaderboardBuckets();
    const ids = [...acc.keys()];
    if (ids.length === 0) return res.json([]);

    const users = await User.find({ _id: { $in: ids }, role: "student", active: true })
      .select("name")
      .lean();

    const rows = users
      .map((u) => {
        const p = acc.get(String(u._id)) ?? { earned: 0, possible: 0 };
        return {
          _id: String(u._id),
          name: u.name,
          earned: p.earned,
          possible: p.possible,
          percent: percentOf(p),
        };
      })
      // Sort on the real name, then mask: ordering by an initial would be unstable
      // across students who share one.
      .sort((a, b) => b.earned - a.earned || b.percent - a.percent || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((r) => ({
        name: req.user ? r.name : maskName(r.name),
        earned: r.earned,
        percent: r.percent,
      }));

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}