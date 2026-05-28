import { z } from "zod";

const TASK_TITLE_MAX = 200;
const TASK_DESC_MAX = 2000;

export const createTaskSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(TASK_TITLE_MAX, `标题不能超过 ${TASK_TITLE_MAX} 个字符`),
  description: z.string().max(TASK_DESC_MAX, `描述不能超过 ${TASK_DESC_MAX} 个字符`).optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式无效，请使用 YYYY-MM-DD")
    .optional()
    .nullable(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(TASK_TITLE_MAX, `标题不能超过 ${TASK_TITLE_MAX} 个字符`).optional(),
  description: z.string().max(TASK_DESC_MAX, `描述不能超过 ${TASK_DESC_MAX} 个字符`).optional().nullable(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式无效，请使用 YYYY-MM-DD")
    .optional()
    .nullable(),
});

export const updateStatusSchema = z.object({
  status: z.enum(["todo", "in_progress", "completed"]),
});

export const taskQuerySchema = z.object({
  status: z.enum(["todo", "in_progress", "completed"]).optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  sortBy: z.enum(["due_date", "created_at", "priority"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  search: z.string().max(100).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
export type TaskQueryInput = z.infer<typeof taskQuerySchema>;
