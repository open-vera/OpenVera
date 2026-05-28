import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export interface AppError {
  statusCode: number;
  code: string;
  message: string;
  details?: Array<{ field: string; message: string }>;
}

export function createAppError(
  statusCode: number,
  code: string,
  message: string,
  details?: Array<{ field: string; message: string }>
): AppError {
  return { statusCode, code, message, details };
}

function formatZodError(error: ZodError): AppError {
  const details = error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
  return createAppError(400, "VALIDATION_ERROR", "数据验证失败", details);
}

function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    "code" in err &&
    "message" in err
  );
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    const appError = formatZodError(err);
    res.status(appError.statusCode).json({
      success: false,
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      },
    });
    return;
  }

  // Known application errors
  if (isAppError(err)) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Unknown errors
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "服务器内部错误",
    },
  });
}
