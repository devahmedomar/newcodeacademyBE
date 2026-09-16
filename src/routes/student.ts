import { Router } from "express";
import { profile, changePassword, remove, restore } from "../controllers/studentController";
import { authGuard, roleGuard } from "../middleware/auth";

const router = Router();

router.use(authGuard);
router.get("/:id?", profile);
router.put("/:id/password", roleGuard("teacher"), changePassword);
router.delete("/:id", roleGuard("teacher"), remove);
router.put("/:id/restore", roleGuard("teacher"), restore);

export default router;