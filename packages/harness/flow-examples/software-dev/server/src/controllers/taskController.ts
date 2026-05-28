import type { Request, Response, NextFunction } from "express";
import * as taskService from "../services/taskService.js";
import type { CreateTaskInput, UpdateTaskInput } from "../validation/taskValidation.js";
import type { TaskQueryParams, TaskStatus } from "../types/task.js";

export function getTasks(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const params = req.query as unknown as TaskQueryParams;
    const result = taskService.getTasks(req.userId!, params);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export function getTaskById(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const task = taskService.getTaskById(req.params.id, req.userId!);

    res.status(200).json({
      success: true,
      data: task,
    });
  } catch (error) {
    next(error);
  }
}

export function createTask(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const input = req.body as CreateTaskInput;
    const task = taskService.createTask(req.userId!, input);

    res.status(201).json({
      success: true,
      data: task,
    });
  } catch (error) {
    next(error);
  }
}

export function updateTask(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const input = req.body as UpdateTaskInput;
    const task = taskService.updateTask(req.params.id, req.userId!, input);

    res.status(200).json({
      success: true,
      data: task,
    });
  } catch (error) {
    next(error);
  }
}

export function updateTaskStatus(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const { status } = req.body as { status: TaskStatus };
    const task = taskService.updateTaskStatus(req.params.id, req.userId!, status);

    res.status(200).json({
      success: true,
      data: {
        id: task.id,
        status: task.status,
        updatedAt: task.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
}

export function deleteTask(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    taskService.deleteTask(req.params.id, req.userId!);

    res.status(200).json({
      success: true,
      message: "任务已删除",
    });
  } catch (error) {
    next(error);
  }
}
