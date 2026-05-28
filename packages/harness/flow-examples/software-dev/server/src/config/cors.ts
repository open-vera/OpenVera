import type cors from "cors";

export const corsOptions: cors.CorsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? "https://taskflow.example.com"
      : "http://localhost:5173",
  credentials: true,
  optionsSuccessStatus: 200,
};
