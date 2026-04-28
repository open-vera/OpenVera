<script lang="ts">
  import { listPrompts, BUILT_IN_STEPS, type PromptInfo, type OllamaModelsResult } from "../../api";

  interface Props {
    asrModel: string;
    format: string;
    llmModel: string;
    /** 选中的内置步骤 ID 列表 */
    selectedSteps: string[];
    /** ASR 阶段使用的提示词（仅 Ollama ASR 有效） */
    asrPromptName: string;
    disabled: boolean;
    ollamaModels: OllamaModelsResult | null;
    onAsrModelChange: (v: string) => void;
    onFormatChange: (v: string) => void;
    onLlmModelChange: (v: string) => void;
    onSelectedStepsChange: (v: string[]) => void;
    onAsrPromptChange: (name: string, content: string) => void;
  }
  let {
    asrModel, format, llmModel, selectedSteps, asrPromptName, disabled,
    ollamaModels,
    onAsrModelChange, onFormatChange, onLlmModelChange, onSelectedStepsChange, onAsrPromptChange,
  }: Props = $props();

  // ── ASR 模型选项（MLX 内置 + Ollama 多模态）──────────
  interface AsrOption { value: string; label: string; }

  const mlxOptions: AsrOption[] = [
    { value: "qwen3:0.6B", label: "Qwen3-ASR 0.6B (MLX)" },
    { value: "qwen3:1.7B", label: "Qwen3-ASR 1.7B (MLX)" },
    { value: "parakeet:0.6B", label: "Parakeet TDT 0.6B (MLX)" },
    { value: "vibevoice:9B", label: "VibeVoice-ASR 9B" },
    { value: "gemma:E4B", label: "Gemma 4 E4B" },
  ];

  let asrOptions = $derived<AsrOption[]>(() => {
    const opts = [...mlxOptions];
    if (ollamaModels?.available && ollamaModels.asr_models.length > 0) {
      for (const m of ollamaModels.asr_models) {
        opts.push({ value: `ollama:${m.name}`, label: `${m.name} (Ollama)` });
      }
    }
    return opts;
  });

  // ── 提示词（仅供 ASR 提示词选择使用）───────────────────
  let prompts = $state<PromptInfo[]>([]);

  $effect(() => {
    listPrompts().then(res => {
      prompts = res.prompts;
    });
  });

  function toggleStep(id: string) {
    if (selectedSteps.includes(id)) {
      onSelectedStepsChange(selectedSteps.filter(s => s !== id));
    } else {
      onSelectedStepsChange([...selectedSteps, id]);
    }
  }

  // ── 模型描述 map（前缀匹配，未收录的只展示模型名）──────────
  interface ModelMeta { label: string; hint: string; }
  const MODEL_META: [string, ModelMeta][] = [
    ["qwen3.5",   { label: "综合最强 · 中文★★★★★", hint: "综合能力最强的中文模型，擅长语义理解和文本生成，推荐用于纠错、说话人分离等重任务" }],
    ["qwen3",     { label: "速度均衡 · 中文★★★★★", hint: "平衡型中文模型，速度和质量兼顾，适合大批量处理" }],
    ["gemma3",    { label: "轻量快速 · 中文★★★☆☆", hint: "Google 出品，结构化输出能力好，适合内容标签、质量评分等判断任务" }],
    ["deepseek",  { label: "中文优秀 · 中文★★★★★", hint: "深度求索，中文理解优秀，擅长纠错与说话人分离" }],
    ["llama3",    { label: "英文强 · 中文★★★☆☆",   hint: "Meta 出品，英文能力强，中文可用，适合翻译、摘要" }],
    ["phi4",      { label: "轻巧推理 · 中文★★☆☆☆",  hint: "微软出品，小巧但推理能力强，适合质量评分、标签分类" }],
    ["phi3",      { label: "轻巧推理 · 中文★★☆☆☆",  hint: "微软出品，小巧但推理能力强，适合质量评分、标签分类" }],
    ["mistral",   { label: "多语言 · 中文★★☆☆☆",   hint: "欧洲团队，多语言平衡，适合翻译、摘要" }],
  ];

  function getModelMeta(name: string): ModelMeta | null {
    const lower = name.toLowerCase();
    for (const [prefix, meta] of MODEL_META) {
      if (lower.startsWith(prefix)) return meta;
    }
    return null;
  }

  function modelOptionLabel(name: string): string {
    const meta = getModelMeta(name);
    return meta ? `${name}  ·  ${meta.label}` : name;
  }

  let currentLlmMeta = $derived(llmModel ? getModelMeta(llmModel) : null);

  let ollamaAvailable = $derived(ollamaModels?.available ?? false);
  let llmOptions = $derived(ollamaModels?.llm_models ?? []);
  let isOllamaAsr = $derived(asrModel.startsWith("ollama:"));
</script>

<div class="config-bar">
  <!-- ASR 设置区 -->
  <fieldset class="config-section">
    <legend>ASR 设置</legend>
    <div class="section-fields">
      <label class="field">
        模型
        <select value={asrModel} {disabled} onchange={(e) => onAsrModelChange((e.target as HTMLSelectElement).value)}>
          {#each asrOptions() as opt}<option value={opt.value}>{opt.label}</option>{/each}
        </select>
      </label>

      <label class="field">
        格式
        <select value={format} {disabled} onchange={(e) => onFormatChange((e.target as HTMLSelectElement).value)}>
          <option value="jsonl">JSONL</option>
          <option value="csv">CSV</option>
        </select>
      </label>

      {#if isOllamaAsr}
        <label class="field">
          提示词
          <select
            value={asrPromptName}
            {disabled}
            onchange={(e) => {
              const name = (e.target as HTMLSelectElement).value;
              const content = prompts.find(p => p.name === name)?.content ?? "";
              onAsrPromptChange(name, content);
            }}
          >
            <option value="">默认</option>
            {#each prompts as p}<option value={p.name}>{p.name}</option>{/each}
          </select>
        </label>
      {/if}
    </div>
  </fieldset>

  <!-- LLM 标注区 -->
  <fieldset class="config-section" class:section-disabled={!ollamaAvailable}>
    <legend>LLM 标注</legend>
    <div class="section-fields">
      <label class="field">
        模型
        {#if ollamaAvailable}
          <select class="llm-select" value={llmModel} {disabled} onchange={(e) => onLlmModelChange((e.target as HTMLSelectElement).value)}>
            <option value="">不使用</option>
            {#each llmOptions as m}<option value={m.name}>{modelOptionLabel(m.name)}</option>{/each}
          </select>
          {#if currentLlmMeta}
            <span class="model-hint">{currentLlmMeta.hint}</span>
          {/if}
        {:else}
          <select disabled>
            <option>Ollama 未连接</option>
          </select>
        {/if}
      </label>

      <div class="field field-steps">
        <span class="field-label">处理步骤</span>
        <div class="step-chips" class:chips-disabled={disabled || !ollamaAvailable || !llmModel}>
          {#each BUILT_IN_STEPS as step}
            <button
              class="chip"
              class:selected={selectedSteps.includes(step.id)}
              disabled={disabled || !ollamaAvailable || !llmModel}
              onclick={() => toggleStep(step.id)}
              title={step.prompt}
            >{step.label}</button>
          {/each}
        </div>
      </div>
    </div>
  </fieldset>
</div>

<style>
  .config-bar {
    display: flex;
    gap: 12px;
    align-items: stretch;
    padding: 4px 0;
    flex-wrap: wrap;
  }
  .config-section {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--pico-muted-border-color);
    border-radius: 8px;
    padding: 8px 12px 10px;
    margin: 0;
    flex: 1;
    min-width: 200px;
  }
  .config-section legend {
    font-size: 11px;
    font-weight: 700;
    opacity: 0.5;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 0 4px;
  }
  .section-fields {
    display: flex;
    gap: 12px;
    align-items: end;
    flex-wrap: wrap;
  }
  .section-disabled {
    opacity: 0.5;
  }
  .field {
    font-size: 13px;
    color: var(--pico-muted-color);
    margin: 0;
  }
  .field select {
    padding: 6px 10px;
    margin-top: 2px;
    font-size: 13px;
  }
  .llm-select {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .field-steps {
    flex: 1;
    min-width: 120px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: 13px;
    color: var(--pico-muted-color);
  }
  .step-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chips-disabled { opacity: 0.5; pointer-events: none; }
  .chip {
    all: unset;
    cursor: pointer;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 12px;
    border: 1px solid var(--pico-muted-border-color);
    background: var(--pico-card-sectioning-background-color);
    color: var(--pico-contrast);
    transition: all 0.15s;
  }
  .chip:hover { border-color: var(--pico-primary); }
  .chip.selected {
    background: var(--pico-primary);
    color: white;
    border-color: var(--pico-primary);
  }
  .model-hint {
    display: block;
    font-size: 11px;
    opacity: 0.5;
    margin-top: 2px;
    line-height: 1.3;
  }
</style>
