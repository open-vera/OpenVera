import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import morgan from "morgan";
import authRoutes from "./routes/authRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";

// --- App Initialization ---

const app = express();

// --- Global Middleware ---

app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Health Check ---

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- Routes ---

app.use("/api/auth", authRoutes);
app.use("/api/tasks", taskRoutes);

// --- 404 Handler ---

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "请求的资源不存在",
    },
  });
});

// --- Error Handler Middleware ---

interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

app.use((err: AppError, _req: Request, res: Response, _next: NextFunction) => {
  const statusCode = err.statusCode ?? 500;
  const code = err.code ?? "INTERNAL_SERVER_ERROR";
  const message = statusCode === 500 ? "服务器内部错误" : err.message;

  console.error(`[Error] ${statusCode} - ${code}: ${err.message}`);

  if (statusCode === 500 && err.stack) {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    error: { code, message },
  });
});

// --- Export ---

export default app;
