import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/token.js";
import { createAppError } from "./errorHandler.js";

export function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const error = createAppError(401, "UNAUTHORIZED", "未提供认证令牌");
    next(error);
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch {
    const error = createAppError(401, "TOKEN_EXPIRED", "认证令牌无效或已过期");
    next(error);
  }
}
