import { renderMarkdown } from "./markdown.js";

export interface MarkdownWorkerRequest {
  id: number;
  source: string;
}

export interface MarkdownWorkerResponse {
  id: number;
  html?: string;
  error?: string;
}

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  const { id, source } = event.data;
  try {
    const html = renderMarkdown(source);
    const response: MarkdownWorkerResponse = { id, html };
    self.postMessage(response);
  } catch (error) {
    const response: MarkdownWorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
