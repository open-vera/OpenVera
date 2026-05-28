import type { Request, Response, NextFunction } from "express";
import type { ZodSchema, ZodError } from "zod";

interface ValidationErrorDetail {
  field: string;
  message: string;
}

function formatZodError(error: ZodError): ValidationErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

type RequestPart = "body" | "query" | "params";

export function validate(schema: ZodSchema, source: RequestPart = "body") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "数据验证失败",
          details: formatZodError(result.error),
        },
      });
      return;
    }
    req[source] = result.data;
    next();
  };
}
