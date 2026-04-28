# UI & Pipeline 问题整理

> 日期：2026-04-04
> 状态：待确认后修复

---

## 背景

用户在外部测试发现以下问题，经代码审查定位了根本原因，现整理成文档对齐修复方案。

---

## 问题一：SetupWizard 安装按钮点击后立刻变成"重试"

### 现象
点击"安装"按钮后，几乎立刻变成"重试"，没有安装中状态。

### 根本原因
`server.py` 的命令白名单 `_allowed_prefixes()` 缺少两个 install_cmd 前缀：

| install_cmd 来源 | 命令前缀 | 白名单中有？ |
|---|---|---|
| `check_homebrew()` | `/bin/bash -c "$(curl ...)"` | ✗ |
| `check_ml_venv()` | `python3 -m venv '...' && ...` | ✗ |

命令不在白名单 → `_check_cmd` 返回 HTTP 400 → `EventSource.onerror` 触发 → `installDone[name] = false` → 立刻显示"重试"。

另外 `python3 -m venv '...' && pip install ...` 用了 `&&`，`shlex.split` 无法正确处理 shell 运算符，即使白名单通过也只会执行 `python3 -m venv` 部分，后续 pip 不会运行。

### 修复方案（已完成）
- `_allowed_prefixes()` 新增 `/bin/bash -c ` 和 `python3 -m venv `
- `subprocess.Popen(shlex.split(cmd))` → `subprocess.Popen(cmd, shell=True)` 支持 `&&` / `$()` 等 shell 语法
- 移除已无用的 `import shlex`

### 修改文件
- `src/audio_label/server.py`

---

## 问题二：SetupWizard 安装进度面板互相覆盖

### 现象
多个依赖同时安装（或先后安装）时，前一个的安装日志被后一个覆盖，只能看到最新一个的进度。

### 根本原因
日志面板是单一共享的 `activeLog`，用 derived 选出"当前最活跃"的那一个，其余日志不可见。

### 修复方案（已完成）
- 移除 `activeLog` 派生变量和共享日志面板
- 在每个 `check-item` 下方内联渲染各自的 `<details>` 日志面板
- 每项独立展示自己的安装进度和日志

### 修改文件
- `gui/src/views/SetupWizard.svelte`

---

## 问题三：LLM 阶段顶栏状态空白 / 资源占用消失

### 现象
ASR 全部完成后进入 LLM 批量标注阶段，顶栏中间区域完全空白（截图中红框），
MEM 资源占用组件也消失，无法判断 LLM 是否在运行。

### 根本原因
- `StatusBar` 的 `visible` 条件只有 `isAnnotating`（ASR 阶段），LLM 阶段为 `false`
- 顶部状态文字同样只在 `isAnnotating && statusMessage` 时显示，`statusMessage` 来自 ASR 后端事件，LLM 阶段为空
- LLM 当前处理的文件名 (`labelingFile`) 没有展示到顶栏

### 修复方案（待实施）

**StatusBar：**
```
visible={isAnnotating || isBatchLabeling}
```

**状态文字（新增 LLM 状态派生）：**
```js
let llmStatusMsg = $derived(labelingFile ? `LLM：${fileName(labelingFile)}` : "");
```
顶栏条件：ASR 阶段展示 `statusMessage`，LLM 阶段展示 `llmStatusMsg`。

### 修改文件
- `gui/src/views/ResultsView.svelte`

---

## 问题四：进度计数器"46/46 完成"混淆 ASR 和 LLM

### 现象
进入 LLM 阶段后右上角显示"46/46 完成"，这是 ASR 的完成数，而 LLM 才刚开始（0/46）。两个阶段的进度叠在一个数字里，用户无法分辨。

### 根本原因
右上角只有一个 `{successCount}/{totalFiles} 完成` 展示，是 ASR 的数字。LLM 进度（`batchLabelProgress/batchLabelTotal`）只体现在"停止 AI (n/N)"按钮文字里，位置偏且语义不清。

### 修复方案（待实施）

拆分为两个独立展示块：

```
ASR 阶段:   [ASR 22/46 ⟳]
LLM 阶段:   [ASR 46/46]  [LLM 8/46 ⟳]
全部完成:   [ASR 46/46]  [LLM 46/46]
```

实现方式：
- 新增派生 `llmDoneCount = $derived(Object.keys(aiLabels).length)` 用于 LLM 完成数持久展示
- ASR 进度块始终展示，spinner 在 `isAnnotating` 时显示
- LLM 进度块在 `isBatchLabeling || llmDoneCount > 0` 时展示

### 修改文件
- `gui/src/views/ResultsView.svelte`

---

## 问题五：暂停/停止按钮在 LLM 阶段消失，且无法控制 LLM

### 现象
- ASR 阶段有 ⏸暂停 / ▶继续 / ⏹结束 按钮
- LLM 阶段这三个按钮消失，只剩"停止 AI (n/N)"
- LLM 没有暂停功能，无法在文件间暂停

### 根本原因
- 暂停/停止按钮条件是 `{#if isAnnotating}`，LLM 阶段不满足
- `runBatchLabel` 循环只检查 `batchLabelCancelled`，没有暂停等待逻辑

### 修复方案（待实施）

**新增状态：**
```js
let batchLabelPaused = $state(false);
```

**统一处理函数：**
```js
function handlePause() {
  if (isAnnotating) onPause();
  else if (isBatchLabeling) batchLabelPaused = true;
}
function handleResume() {
  if (isPaused) onResume();
  if (batchLabelPaused) batchLabelPaused = false;
}
function handleStop() {
  if (isAnnotating) onStop();
  if (isBatchLabeling) batchLabelCancelled = true;
}
```

**`runBatchLabel` 加入暂停等待：**
```js
for (const file of toLabel) {
  if (batchLabelCancelled) break;
  while (batchLabelPaused && !batchLabelCancelled) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (batchLabelCancelled) break;
  await labelOne(file);
  batchLabelProgress += 1;
}
```

**顶栏按钮条件改为统一控制：**
```svelte
{#if isAnnotating || isBatchLabeling}
  {#if isPausedAny}
    <button onclick={handleResume}>▶ 继续</button>
  {:else}
    <button onclick={handlePause}>⏸ 暂停</button>
  {/if}
  <button onclick={handleStop}>⏹ 停止</button>
{/if}
```

其中 `isPausedAny = $derived(isPaused || batchLabelPaused)`。

**行为定义：**
- 暂停：下一个文件开始前生效，当前文件处理完成后等待，可恢复
- 停止：不可恢复，ASR stop 由后端终止进程，LLM cancelled 中止循环

### 修改文件
- `gui/src/views/ResultsView.svelte`

---

## 问题六：按钮命名不一致

### 现象
- ASR 停止按钮叫"结束"，其他地方叫"停止"
- LLM 停止显示在"停止 AI (n/N)"按钮里，位置和命名都混乱

### 修复方案（待实施）

| 当前 | 改成 |
|---|---|
| ⏹ 结束 | ⏹ 停止 |
| 停止 AI (n/N) | 去掉此按钮，进度显示到专属区域，停止并入左侧统一按钮 |
| 批量 AI 标注 | 保留，仅在空闲且已配置 LLM 时显示（手动触发入口） |

### 修改文件
- `gui/src/views/ResultsView.svelte`（问题六）

---

## 问题七：说话人分离输出格式错误 + 长音频分块后 Speaker ID 不连续

### 现象
截图（吞噬07.mp3，20:56）的说话人分离结果输出如下：
```
[15:30.1] 我
[15:32.0] 他
[15:34.7] 这小子
...
```
- 带时间戳，非预期的 `Speaker A: 文本` 格式
- 每行只有一两个字，没有按说话人分组
- LLM 实际上只是重新排列了输入，没有识别说话人

### 根本原因分析

**原因 1：短 segment 问题**
`吞噬07.mp3` 是有声书/配音剧，ASR 切出的 segment 极短（单词或单字级别）。LLM 从单个字判断说话人几乎不可能。

**原因 2：LLM 被时间戳格式带跑**
`_format_segments` 给每个 segment 加了 `[M:SS.s - M:SS.s]` 时间戳前缀。当前 prompt 没有明确说"输出中不要包含时间戳"，LLM 学着输入格式输出了带时间戳的结果，但忘记加 `Speaker A:` 前缀。

**原因 3：分块后 Speaker ID 不连续**
20 分钟音频约 600+ segments，按 2000 字符分块会产生 8 个以上的 chunk。每个 chunk 独立分配 `Speaker A / Speaker B`，chunk 间同一角色可能被标记为不同 ID，合并后 Speaker 标签完全没有全局一致性。

**原因 4：LLM 调用完全没有日志**
`labeler.py` 没有任何 logging，出错无法判断是 LLM 没返回、上下文超限、还是输出格式错误。

### 是否是上下文超限？
从代码分析：单个 chunk ≤ 2000 字符，gemma3:4b 默认 context 约 8K tokens，**单 chunk 不会超限**。更可能的原因是 prompt 不够明确 + 短 segment 导致 LLM 无法判断说话人，而非上下文超限。

### 修复方案（待实施）

**1. 修改 diarization prompt，明确禁止时间戳输出：**
```ts
prompt: "请在 ## 说话人分离 标题下分析对话中的说话人身份。\n"
  + "规则：\n"
  + "1. 将相邻属于同一说话人的内容合并为一条\n"
  + "2. 输出格式严格为「A: 文本内容」，每行一条，不要输出时间戳\n"
  + "3. 说话人用 A、B、C... 表示\n"
  + "4. 若无法判断说话人，用「?: 文本」表示\n"
  + "示例：\nA: 你好，请问有什么事？\nB: 我想咨询一下。"
```

**2. 对说话人分离任务改用无时间戳的纯文本格式**
在 `labeler.py` 的 `label_transcript` 中，对含关键词 `diarization` 的 prompt_name，改用 segment 文本按行拼接（不含时间戳），避免 LLM 复制时间戳。

**3. 加入 LLM 调用日志**
在 `labeler.py` 的 `_call_llm` 中加 DEBUG 日志，记录 chunk 大小、模型、耗时和输出摘要，方便排查。

### 修改文件
- `gui/src/api.ts`（diarization prompt）
- `src/audio_label/pipeline/labeler.py`（日志 + diarization 禁用时间戳格式）

---



### 问题
ASR 完成部分文件后，能否立刻对这部分文件做 LLM，不等全部 ASR 完成？

### 当前行为
**等全部 ASR 完成再 LLM。**

`ResultsView.svelte` 的 `$effect` 在 `isAnnotating` 变为 false（ASR 全部结束）后才触发 `runBatchLabel()`，属于两阶段顺序执行。

### 后端能力
`AnnotationScheduler` 支持真流水线（ASR 完成一个即入 `llm_queue`，LLM workers 并行处理），但需要前端在 `startAnnotate` 时传入 `llm_config`，目前未走这条路。

### 为何现在不做流水线
- MLX ASR 占 ANE/GPU，Ollama LLM 占内存，M 系列同时跑资源竞争严重
- 分阶段展示对用户更直观，进度和状态更清晰
- 流水线需要后端驱动 LLM（不能再用前端 `/api/label` 调用），改动范围大

### 结论
**维持现状，不在本次修改范围内。** 如需要，后续单独排期。

---

## 问题八：翻译步骤对英文音频输出英文（未翻译）

### 现象
英文音频经 ASR 转写后，选"翻译"步骤，AI 标注区显示的"翻译"结果仍然是英文——仅做了润色/纠错，没有翻译成中文。

截图中可看到 `Video 1.wav`（English）翻译结果依然是英文段落。

### 根本原因
`gui/src/api.ts` 的 `BUILT_IN_STEPS` 中翻译 prompt 写死了目标语言：

```ts
prompt: "请在 ## 翻译 标题下将转写内容翻译为英文，保持原意和语气。",
```

英文 → 英文，LLM 直接做润色而非翻译。

### 修复方案（待实施）

改为让 LLM 自动判断源语言，反向翻译：

```ts
prompt: "请在 ## 翻译 标题下将转写内容翻译为目标语言：若原文为中文则译为英文，若原文为英文（或其他语言）则译为中文。保持原意和语气，不要输出原文。",
```

这样无需前端检测语言，LLM 自行判断源语言并输出对应译文。

### 修改文件
- `gui/src/api.ts`（`BUILT_IN_STEPS` 中 `translation` 的 `prompt` 字段）

---

## 修改范围汇总

| 文件 | 问题 | 状态 |
|---|---|---|
| `src/audio_label/server.py` | 问题一（白名单 + shell=True） | ✅ 已完成 |
| `gui/src/views/SetupWizard.svelte` | 问题二（日志面板内联） | ✅ 已完成 |
| `gui/src/views/ResultsView.svelte` | 问题三、四、五、六（顶栏重构） | ⬜ 待实施 |
| `gui/src/api.ts` | 问题七（diarization prompt）、问题八（翻译 prompt） | ⬜ 待实施 |
| `src/audio_label/pipeline/labeler.py` | 问题七（日志 + diarization 禁用时间戳） | ⬜ 待实施 |

---

## 待确认项（已全部确认）

1. **"全部完成"状态展示**
   → 右上角显示绿色 `N/N 已完成`，不再拆分 ASR/LLM 分类计数。

2. **LLM 暂停粒度**
   → 立即暂停。当前文件若已有结果则保存，若 ASR/LLM 还未完成则丢弃，不等文件处理完。

3. **手动触发"批量 AI 标注"入口**
   → 不需要，按钮已移除（✅ 已完成）。
