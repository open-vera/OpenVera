import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface RagSearchHit {
  path: string;
  snippet: string;
  score: number;
}

export interface RagSearchResult {
  query: string;
  hits: RagSearchHit[];
  mode: "vector" | "keyword" | "empty";
  message?: string;
}

async function walkFiles(dir: string, files: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return files;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, files);
    } else if (/\.(md|txt|json|jsonl)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export async function searchProjectRag(projectRoot: string, query: string, limit = 8): Promise<RagSearchResult> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return { query, hits: [], mode: "empty", message: "Query is empty" };
  }

  const ragDir = join(projectRoot, ".vera", "rag");
  const vectorDb = join(ragDir, "vectors.db");
  if (existsSync(vectorDb)) {
    return {
      query,
      hits: [],
      mode: "vector",
      message: "向量索引已存在，但 Gateway 尚未绑定 embedding adapter；已回退关键词检索。",
    };
  }

  const files = await walkFiles(ragDir);
  const hits: RagSearchHit[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw.toLowerCase().includes(normalized)) continue;
    const index = raw.toLowerCase().indexOf(normalized);
    const start = Math.max(0, index - 40);
    const snippet = raw.slice(start, start + 160).replace(/\s+/g, " ").trim();
    hits.push({
      path: file.replace(projectRoot, "").replace(/^\//, ""),
      snippet,
      score: 1,
    });
    if (hits.length >= limit) break;
  }

  return {
    query,
    hits,
    mode: hits.length > 0 ? "keyword" : "empty",
    message: hits.length === 0 ? "未在 .vera/rag 中找到匹配内容" : undefined,
  };
}
