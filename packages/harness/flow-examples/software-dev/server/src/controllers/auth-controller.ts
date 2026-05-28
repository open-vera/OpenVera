import type { Request, Response, NextFunction } from "express";
import * as authService from "../services/authService.js";
import type { RegisterInput, LoginInput } from "../validation/authValidation.js";

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = req.body as RegisterInput;
    const result = await authService.register(input);

    if (!result.success) {
      const statusCode = result.error.code === "CONFLICT" ? 409 : 400;
      res.status(statusCode).json({ success: false, error: result.error });
      return;
    }

    res.status(201).json({ success: true, data: result.data });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = req.body as LoginInput;
    const result = await authService.login(input);

    if (!result.success) {
      res.status(401).json({ success: false, error: result.error });
      return;
    }

    res.status(200).json({ success: true, data: result.data });
  } catch (err) {
    next(err);
  }
}

export function getMe(req: Request, res: Response, next: NextFunction): void {
  try {
    const userId = req.userId!;
    const user = authService.getUserById(userId);

    if (!user) {
      res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "用户不存在" },
      });
      return;
    }

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}
