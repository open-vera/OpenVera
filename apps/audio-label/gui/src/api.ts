const API_BASE = "http://127.0.0.1";
let port: number = 0;

export function setPort(p: number) {
  port = p;
}

/** 从 Tauri 后端获取 Python 服务端口 */
export async function initPort(): Promise<number> {
  if (port > 0) return port;

  // Tauri 环境：通过 invoke 获取
  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    const p = await invoke<number>("get_server_port");
    setPort(p);
    return p;
  }

  // 纯浏览器开发：从 URL 参数或默认 8000
  const params = new URLSearchParams(window.location.search);
  const p = parseInt(params.get("port") || "8000", 10);
  setPort(p);
  return p;
}

function url(path: string): string {
  return `${API_BASE}:${port}${path}`;
}

/** 获取音频文件播放 URL */
export function audioUrl(filePath: string): string {
  return url(`/api/audio?path=${encodeURIComponent(filePath)}`);
}

export interface AudioFileInfo {
  path: string;
  name: string;
  duration_sec: number | null;
  sample_rate: number | null;
  channels: number | null;
  size_bytes: number | null;
}

export interface ProgressEvent {
  event: string;
  // 通用
  current?: number;
  total?: number;
  file?: string;
  text?: string;
  error?: string;
  output?: string;
  output_dir?: string;
  success?: number;
  total_files?: number;
  message?: string;
  backend?: string;
  model_size?: string;
  results?: AnnotationResult[];
  // 并行流水线事件
  worker?: number; // asr_start / asr_done / llm_start / llm_done
  index?: number; // asr_start：文件序号
  elapsed?: number; // asr_done / llm_done：耗时（秒）
  step?: string; // llm_start / llm_done：提示词名称
  asr_workers?: number; // pipeline_start / load_adjust
  llm_workers?: number; // pipeline_start / load_adjust
  has_llm?: boolean; // pipeline_start
  reason?: string; // load_adjust
  cpu_percent?: number; // load_adjust
  memory_percent?: number; // load_adjust
}

export async function health(): Promise<{
  status: string;
  backends: string[];
  ollama_available: boolean;
}> {
  const res = await fetch(url("/api/health"));
  return res.json();
}

/** 系统资源快照（状态栏 3s 轮询） */
export interface SystemStats {
  cpu_percent: number;
  memory_used_gb: number;
  memory_total_gb: number;
  memory_percent: number;
  gpu_percent: number | null;
  temperature: number | null;
  thermal_throttled: boolean;
  model_memory: { asr: number | null; llm: number | null };
  llm_concurrency: number;
}

export async function getSystemStats(): Promise<SystemStats> {
  const res = await fetch(url("/api/system-stats"));
  return res.json();
}

/** 应用状态持久化 */
export async function getState(): Promise<Record<string, string>> {
  const res = await fetch(url("/api/state"));
  return res.json();
}

export async function saveState(key: string, value: string): Promise<void> {
  await fetch(url("/api/state"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
  install_cmd: string | null;
}

export interface PreflightResult {
  checks: CheckItem[];
  ready: boolean;
}

export async function preflight(): Promise<PreflightResult> {
  const res = await fetch(url("/api/preflight"));
  return res.json();
}

export async function install(
  cmd: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await fetch(url("/api/install"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd }),
  });
  return res.json();
}

/** SSE 流式安装，实时返回日志行 */
export function installStream(
  cmd: string,
  onEvent: (ev: {
    event: string;
    cmd?: string;
    line?: string;
    ok?: boolean;
    error?: string;
  }) => void
): () => void {
  const eventSource = new EventSource(
    url(`/api/install?cmd=${encodeURIComponent(cmd)}`)
  );
  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    onEvent(data);
    if (data.event === "done") {
      eventSource.close();
    }
  };
  eventSource.onerror = () => {
    onEvent({ event: "done", ok: false, error: "连接中断" });
    eventSource.close();
  };
  return () => eventSource.close();
}

/** 模型管理 */
export interface ModelInfo {
  id: string;
  name: string;
  size: string;
  installed: boolean;
  install_cmd: string;
}

export interface ModelsResult {
  models: ModelInfo[];
  installed_count: number;
}

export async function listModels(): Promise<ModelsResult> {
  const res = await fetch(url("/api/models"));
  return res.json();
}

export async function uninstallModel(
  model_id: string
): Promise<{ ok: boolean; errors: string[] }> {
  const res = await fetch(url("/api/models/uninstall"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_id }),
  });
  return res.json();
}

/** 提示词管理 */
export interface PromptInfo {
  name: string;
  content: string;
  preview: string;
}

export async function listPrompts(): Promise<{ prompts: PromptInfo[] }> {
  const res = await fetch(url("/api/prompts"));
  return res.json();
}

export async function savePrompt(
  name: string,
  content: string
): Promise<{ ok: boolean }> {
  const res = await fetch(url("/api/prompts"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content }),
  });
  return res.json();
}

export async function deletePrompt(name: string): Promise<{ ok: boolean }> {
  const res = await fetch(
    url(`/api/prompts?name=${encodeURIComponent(name)}`),
    { method: "DELETE" }
  );
  return res.json();
}

/** 保存手动标注到结果文件 */
export async function saveAnnotations(
  outputDir: string,
  file: string,
  annotations: ManualAnnotation[]
): Promise<{ ok: boolean }> {
  const res = await fetch(url("/api/save-annotations"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ output_dir: outputDir, file, annotations }),
  });
  return res.json();
}

/** 结果数据类型 */
export interface AnnotationResult {
  file: string;
  text: string;
  language: string | null;
  duration_sec: number | null;
  sample_rate: number | null;
  segments: { start: number; end: number; text: string }[];
  words: { start: number; end: number; text: string }[];
  chunks?: { start: number; end: number; text: string }[];
  labels?: LabelResultData[];
  annotations?: ManualAnnotation[];
}

export interface ManualAnnotation {
  start: number;
  end: number;
  value: string;
}

export async function scan(paths: string[]): Promise<AudioFileInfo[]> {
  const res = await fetch(url("/api/scan"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  return res.json();
}

export async function startAnnotate(params: {
  files: string[];
  backend: string;
  model_size: string;
  format: string;
  output?: string;
  prompt?: string;
  // 并行流水线：LLM 后处理（可选）
  llm_model?: string;
  prompt_name?: string;
  prompt_content?: string;
  llm_workers?: number;
  // 质量增强
  denoise?: boolean;
  diarize?: boolean;
  num_speakers?: number;
}): Promise<{ status: string; total: number }> {
  const res = await fetch(url("/api/annotate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function pauseAnnotate(): Promise<void> {
  await fetch(url("/api/annotate/pause"), { method: "POST" });
}

export async function resumeAnnotate(): Promise<void> {
  await fetch(url("/api/annotate/resume"), { method: "POST" });
}

export async function stopAnnotate(): Promise<void> {
  await fetch(url("/api/annotate/stop"), { method: "POST" });
}

export function subscribeProgress(
  onEvent: (ev: ProgressEvent) => void
): () => void {
  const eventSource = new EventSource(url("/api/progress"));

  eventSource.onmessage = (e) => {
    const data: ProgressEvent = JSON.parse(e.data);
    onEvent(data);
    if (data.event === "done" || data.event === "error") {
      eventSource.close();
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
  };

  return () => eventSource.close();
}

/** Ollama 模型 */
export interface OllamaModelInfo {
  name: string;
  size: number;
}

export interface OllamaModelsResult {
  available: boolean;
  asr_models: OllamaModelInfo[];
  llm_models: OllamaModelInfo[];
}

export async function listOllamaModels(): Promise<OllamaModelsResult> {
  const res = await fetch(url("/api/ollama-models"));
  return res.json();
}

/** 卸载 Ollama 模型（ollama rm） */
export async function ollamaRm(
  model: string
): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(url("/api/ollama/rm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return res.json();
}

/** LLM 标注 */
export interface LabelResultData {
  prompt_name: string;
  model: string;
  result: string;
  segment_labels?: { seg_idx: number; label: string }[] | null;
  label_confidence?: {
    overall?: number;
    labels?: Record<string, number>;
  } | null;
  /** 按 ## 标题拆分的各 section，key 为标题名 */
  sections?: Record<string, string> | null;
}

/** 内置 LLM 后处理步骤 */
export interface BuiltInStep {
  id: string;
  label: string;
  prompt: string;
}

export const BUILT_IN_STEPS: BuiltInStep[] = [
  {
    id: "correction",
    label: "纠错",
    prompt:
      "请在 ## 纠错 标题下修正转写中的 ASR 识别错误（同音字、漏字、错字），直接输出修正后的完整文本，不改变原意。",
  },
  {
    id: "diarization",
    label: "说话人",
    prompt:
      '请在 ## 说话人分离 标题下分析对话中的说话人身份，以"Speaker A: 文本"格式逐行输出，每行一句。',
  },
  {
    id: "tagging",
    label: "内容标签",
    prompt:
      "请在 ## 内容标签 标题下输出以下维度的标签：\n- 场景：（客服/会议/访谈/闲聊/其他）\n- 情感：（正面/负面/中立/混合）\n- 关系：（同事/客户/朋友/陌生人/其他）\n- 话题：（1-3个关键词）",
  },
  {
    id: "translation",
    label: "翻译",
    prompt: "请在 ## 翻译 标题下将转写内容翻译为英文，保持原意和语气。",
  },
  {
    id: "quality",
    label: "质量评分",
    prompt:
      "请在 ## 质量评分 标题下评估此转写质量，格式：\n评分：X/5\n理由：（简短说明）",
  },
];

export async function labelFile(params: {
  file: string;
  text: string;
  segments: { start: number; end: number; text: string }[];
  prompt_name: string;
  prompt_content: string;
  model: string;
}): Promise<{ ok: boolean; label?: LabelResultData; error?: string }> {
  const res = await fetch(url("/api/label"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

/** AI 标签人工确认/纠错 */
export async function saveLabelCorrection(params: {
  output_dir: string;
  file: string;
  prompt_name: string;
  model: string;
  ai_result: string;
  human_result: string;
  status: "confirmed" | "corrected";
}): Promise<{ ok: boolean }> {
  const res = await fetch(url("/api/label-corrections"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

/** CER 计算 */
export async function calculateCer(
  hypothesis: string,
  reference: string
): Promise<{ cer: number }> {
  const res = await fetch(url("/api/cer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hypothesis, reference }),
  });
  return res.json();
}

/** 保存转写纠错记录（用于主动学习数据积累）*/
export async function saveCorrections(
  outputDir: string,
  file: string,
  corrections: {
    seg_start: number;
    seg_end: number;
    original: string;
    corrected: string;
  }[]
): Promise<{ ok: boolean }> {
  const res = await fetch(url("/api/save-annotations"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      output_dir: outputDir,
      file,
      annotations: [],
      corrections,
    }),
  });
  return res.json();
}
