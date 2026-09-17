import { Router } from "express";
import * as c from "../controllers/engagementController";
import { authGuard, roleGuard } from "../middleware/auth";

const router = Router();

router.use(authGuard, roleGuard("student"));
router.get("/activity", c.getActivity);
router.post("/watch", c.markWatched);
router.get("/badges", c.getBadges);
router.patch("/settings", c.updateSettings);

export default router;