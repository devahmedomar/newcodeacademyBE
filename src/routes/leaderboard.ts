import { Router } from "express";
import { top } from "../controllers/leaderboardController";
import { optionalAuth } from "../middleware/auth";

const router = Router();

// `optionalAuth`, not `authGuard`: the public landing page renders this before
// anyone signs in. It is there so the controller can tell an anonymous visitor
// (masked names) from a signed-in one (real names).
router.get("/", optionalAuth, top);

export default router;