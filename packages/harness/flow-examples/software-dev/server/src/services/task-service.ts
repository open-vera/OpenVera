import { v4 as uuidv4 } from "uuid";
import * as taskModel from "../models/taskModel.js";
import type {
  Task,
  TaskQueryParams,
  TaskListResponse,
  TaskStatus,
} from "../types/task.js";
import type { CreateTaskInput, UpdateTaskInput } from "../validation/taskValidation.js";

interface TaskError {
  code: string;
  message: string;
}

interface TaskSuccess<T> {
  success: true;
  data: T;
}

interface TaskFailure {
  success: false;
  error: TaskError;
}

type TaskResult<T> = TaskSuccess<T> | TaskFailure;

const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["completed", "todo"],
  completed: ["in_progress"],
};

export function getTasks(
  userId: string,
  params: TaskQueryParams
): TaskListResponse {
  return taskModel.findByUser(userId, params);
}

export function getTaskById(
  userId: string,
  taskId: string
): TaskResult<Task> {
  const task = taskModel.findById(taskId);
  if (!task) {
    return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  }
  if (task.userId !== userId) {
    return { success: false, error: { code: "FORBIDDEN", message: "无权访问该任务" } };
  }
  return { success: true, data: task };
}

export function createTask(
  userId: string,
  input: CreateTaskInput
): Task {
  return taskModel.create({
    id: uuidv4(),
    userId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    dueDate: input.dueDate,
  });
}

export function updateTask(
  userId: string,
  taskId: string,
  input: UpdateTaskInput
): TaskResult<Task> {
  const existing = taskModel.findById(taskId);
  if (!existing) {
    return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  }
  if (existing.userId !== userId) {
    return { success: false, error: { code: "FORBIDDEN", message: "无权修改该任务" } };
  }

  const updated = taskModel.update(taskId, input);
  if (!updated) {
    return { success: false, error: { code: "INTERNAL_ERROR", message: "更新任务失败" } };
  }
  return { success: true, data: updated };
}

export function deleteTask(
  userId: string,
  taskId: string
): TaskResult<{ message: string }> {
  const existing = taskModel.findById(taskId);
  if (!existing) {
    return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  }
  if (existing.userId !== userId) {
    return { success: false, error: { code: "FORBIDDEN", message: "无权删除该任务" } };
  }

  taskModel.remove(taskId);
  return { success: true, data: { message: "任务已删除" } };
}

export function updateTaskStatus(
  userId: string,
  taskId: string,
  newStatus: TaskStatus
): TaskResult<Task> {
  const existing = taskModel.findById(taskId);
  if (!existing) {
    return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  }
  if (existing.userId !== userId) {
    return { success: false, error: { code: "FORBIDDEN", message: "无权修改该任务" } };
  }

  const allowedTransitions = VALID_STATUS_TRANSITIONS[existing.status];
  if (!allowedTransitions.includes(newStatus)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `不允许从 "${existing.status}" 转换到 "${newStatus}"`,
      },
    };
  }

  const updated = taskModel.updateStatus(taskId, newStatus);
  if (!updated) {
    return { success: false, error: { code: "INTERNAL_ERROR", message: "更新状态失败" } };
  }
  return { success: true, data: updated };
}
