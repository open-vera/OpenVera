import { createLogger, format, transports } from "winston";

const loggerFormat = format.combine(
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  format.errors({ stack: true }),
  format.splat(),
  format.printf(({ timestamp, level, message, stack }) => {
    return `${timestamp} [${level}] ${message} ${stack ? stack : ""}`;
  })
);

export const memoryHandlerLogger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: loggerFormat,
  transports: [new transports.Console()],
});

export const checkpointHandlerLogger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: loggerFormat,
  transports: [new transports.Console()],
});

export const subagentHandlerLogger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: loggerFormat,
  transports: [new transports.Console()],
});
