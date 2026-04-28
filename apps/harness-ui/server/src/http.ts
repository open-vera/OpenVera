import type { IncomingMessage, ServerResponse } from "node:http";

export function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function notFound(res: ServerResponse, msg = "Not found"): void {
  json(res, { error: msg }, 404);
}

export function badRequest(res: ServerResponse, msg: string): void {
  json(res, { error: msg }, 400);
}

export function internalError(res: ServerResponse, msg: string): void {
  json(res, { error: msg }, 500);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
