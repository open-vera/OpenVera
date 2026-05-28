import * as taskModel from "../models/taskModel.js";
import { createAppError } from "../middleware/errorHandler.js";
import type {
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  TaskQueryParams,
  TaskListResponse,
  TaskStatus,
} from "../types/task.js";

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["completed"],
  completed: [],
};

export function getTasks(
  userId: string,
  params: TaskQueryParams
): TaskListResponse {
  return taskModel.findTasksByUserId(userId, params);
}

export function getTaskById(id: string, userId: string): Task {
  const task = taskModel.findTaskById(id, userId);
  if (!task) {
    throw createAppError(404, "NOT_FOUND", "任务不存在");
  }
  return task;
}

export function createTask(userId: string, input: CreateTaskInput): Task {
  return taskModel.createTask(userId, input);
}

export function updateTask(
  id: string,
  userId: string,
  input: UpdateTaskInput
): Task {
  const task = taskModel.updateTask(id, userId, input);
  if (!task) {
    throw createAppError(404, "NOT_FOUND", "任务不存在");
  }
  return task;
}

export function updateTaskStatus(
  id: string,
  userId: string,
  status: TaskStatus
): Task {
  const existing = taskModel.findTaskById(id, userId);
  if (!existing) {
    throw createAppError(404, "NOT_FOUND", "任务不存在");
  }

  const allowed = VALID_TRANSITIONS[existing.status];
  if (!allowed.includes(status)) {
    throw createAppError(
      400,
      "VALIDATION_ERROR",
      `不允许从 "${existing.status}" 转换为 "${status}"`
    );
  }

  const task = taskModel.updateTaskStatus(id, userId, status);
  if (!task) {
    throw createAppError(404, "NOT_FOUND", "任务不存在");
  }
  return task;
}

export function deleteTask(id: string, userId: string): void {
  const deleted = taskModel.deleteTask(id, userId);
  if (!deleted) {
    throw createAppError(404, "NOT_FOUND", "任务不存在");
  }
}
