import { Router } from "express";
import { profile } from "../controllers/studentController";
import { authGuard, roleGuard } from "../middleware/auth";

const router = Router();

router.use(authGuard);
router.get("/:id?", profile);

export default router;