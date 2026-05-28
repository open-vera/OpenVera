import type { Request, Response, NextFunction } from "express";
import * as authService from "../services/authService.js";
import type { RegisterInput, LoginInput } from "../validation/authValidation.js";

export async function register(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = req.body as RegisterInput;
    const user = await authService.register({
      email: input.email,
      password: input.password,
    });

    res.status(201).json({
      success: true,
      message: "注册成功",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

export async function login(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = req.body as LoginInput;
    const result = await authService.login({
      email: input.email,
      password: input.password,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export function getCurrentUser(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const user = authService.getCurrentUser(req.userId!);

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
}
