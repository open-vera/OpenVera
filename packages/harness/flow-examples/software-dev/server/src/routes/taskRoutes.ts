import { Router } from "express";
import * as taskController from "../controllers/taskController.js";
import { validate } from "../middleware/validationMiddleware.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  createTaskSchema,
  updateTaskSchema,
  updateStatusSchema,
  taskQuerySchema,
} from "../validation/taskValidation.js";

const router = Router();

router.use(authMiddleware);

router.get("/", validate(taskQuerySchema, "query"), taskController.getTasks);
router.post("/", validate(createTaskSchema), taskController.createTask);
router.get("/:id", taskController.getTaskById);
router.put("/:id", validate(updateTaskSchema), taskController.updateTask);
router.delete("/:id", taskController.deleteTask);
router.patch("/:id/status", validate(updateStatusSchema), taskController.updateTaskStatus);

export default router;
