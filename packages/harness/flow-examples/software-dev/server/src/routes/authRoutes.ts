import { Router } from "express";
import * as authController from "../controllers/authController.js";
import { validate } from "../middleware/validationMiddleware.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { registerSchema, loginSchema } from "../validation/authValidation.js";

const router = Router();

router.post("/register", validate(registerSchema), authController.register);
router.post("/login", validate(loginSchema), authController.login);
router.get("/users/me", authMiddleware, authController.getMe);

export default router;
