import type { Request, Response, NextFunction } from "express";
import * as taskService from "../services/taskService.js";
import type { CreateTaskInput, UpdateTaskInput, UpdateStatusInput, TaskQueryInput } from "../validation/taskValidation.js";

export function getTasks(req: Request, res: Response, next: NextFunction): void {
  try {
    const userId = req.userId!;
    const query = req.query as unknown as TaskQueryInput;
    const result = taskService.getTasks(userId, {
      status: query.status,
      priority: query.priority,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      page: query.page,
      limit: query.limit,
      search: query.search,
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export function getTaskById(req: Request, res: Response, next: NextFunction): void {
  try {
    const userId = req.userId!;
    const taskId = req.params.id;
    const result = taskService.getTaskById(userId, taskId);

    if (!result.success) {
      const statusCode = result.error.code === "NOT_FOUND" ? 404 : 403;
      res.status(statusCode).json({ success: false, error: result.error });
      return;
    }

    res.status(200).json({ success: true, data: result.data });
  } catch (err) {
    next(err);
  }
}

export function createTask(req: Request, res: Response, next: NextFunction): void {
  try {
    const userId = req.userId!;
    const input = req.body as CreateTaskInput;
    const task = taskService.createTask(userId, input);

    res.status(201).json({ success: true, data: task });
  } catch (err) {
    next(err);
  }
}

export function updateTask(req: Request, res: Response, next: NextFunction): void {
  try {
    const userId = req.userId!;
    const taskId = req.params.id;
    const input = req.body as UpdateTaskInput;
    const result = taskService.updateTask(userId, taskId, input);

    if (!result.success) {
      const statusCode = result.error.code === "NOT_FOUND" ? 404 : 403;
      res.status(statusCode).json({ success: false, error: result.error });
      return;
    }

    res.status(200).json({ success: true, data: result.data });
  } catch (err) {
    next(err);
  }
}

export function deleteTask(req: Request, res: Response, next: NextFunction): void {
  try {
    const userId = req.userId!;
    const taskId = req.params.id;
    const result = taskService.deleteTask(userId, taskId);

    if (!result.success) {
      const statusCode = result.error.code === "NOT_FOUND" ? 404 : 403;
      res.status(statusCode).json({ success: false, error: result.error });
      return;
    }

    res.status(200).json({ success: true, data: result.data });
  } catch (err) {
    next(err);
  }
}

export function updateTaskStatus(req: Request, res: Response, next: NextFunction): void {
  try {
    const userId = req.userId!;
    const taskId = req.params.id;
    const { status } = req.body as UpdateStatusInput;
    const result = taskService.updateTaskStatus(userId, taskId, status);

    if (!result.success) {
      const statusCodeMap: Record<string, number> = {
        NOT_FOUND: 404,
        FORBIDDEN: 403,
        VALIDATION_ERROR: 400,
      };
      const statusCode = statusCodeMap[result.error.code] ?? 500;
      res.status(statusCode).json({ success: false, error: result.error });
      return;
    }

    res.status(200).json({ success: true, data: result.data });
  } catch (err) {
    next(err);
  }
}
