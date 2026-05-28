# Case: routing failed — using default model

## 现象

REPL 中出现用户可见消息：

```text
⚠ routing failed — using default model
```

用户确认 `.vera/settings.json` 配置没有问题，并指出 `routing.l0` 到 `routing.l3` 都已配置，且都是同一个模型。

## 上下文

配置形态：

```json
{
  "default_provider": "mimo",
  "default_model": "mimo-v2.5-pro",
  "routing": {
    "enabled": true,
    "classifier": {
      "provider": "mimo",
      "model": "mimo-v2.5-pro"
    },
    "l0": { "provider": "mimo", "model": "mimo-v2.5-pro" },
    "l1": { "provider": "mimo", "model": "mimo-v2.5-pro" },
    "l2": { "provider": "mimo", "model": "mimo-v2.5-pro" },
    "l3": { "provider": "mimo", "model": "mimo-v2.5-pro" }
  }
}
```

涉及模块：

- `packages/core/src/repl/ui/controller/routing.ts`
- `packages/core/src/repl/ui/controller/turnLifecycle.ts`
- `packages/core/src/repl/ui/controller/turnRunner.ts`
- `packages/core/tests/repl-ui-routing.test.ts`
- `packages/core/tests/repl-ui-turn-lifecycle.test.ts`
- `packages/core/tests/repl-ui-turn-runner.test.ts`

## 根因

原逻辑只要 `routing.enabled = true`，每轮 REPL 都会先调用 classifier 做意图分类。

但在这个配置下，`l0`、`l1`、`l2`、`l3` 全部指向默认 provider/model。无论 classifier 判断结果是什么，最终都会路由到同一个模型。因此 classifier 调用没有收益，只会增加延迟、成本和失败面。

进一步复现后确认，classifier 的真实失败原因不是 `.vera/settings.json` 配置错误，也不是鉴权或 base URL 错误。同一配置下，简单 `hello` 可以成功分类。

失败发生在复杂中文输入上，例如：

```text
接下来跑一下这个项目启动试试看好用吗
main 拉到auto/r6最新位置,然后合入 feature 分支代码
```

当时 `classifyIntent()` 给 classifier 请求硬编码了 `max_tokens: 128`。`mimo-v2.5-pro` 会返回额外的 `thinking` content block，输出 token 很容易被 thinking 消耗掉，导致 JSON 正文被截断或无法被当前 adapter 提取成完整 text。最终 `JSON.parse(extractJson(text))` 抛出：

```text
SyntaxError: Unexpected end of JSON input
```

当 classifier 抛错后，路由控制器会降级到默认模型，并把 `failed = true` 传给 turn runner。turn runner 再通过 `appendRoutingFailedMessage` 把降级提示作为 assistant 消息插入聊天内容。

问题不在配置，而在两个产品行为：

1. 无差异路由配置下仍然调用 classifier。
2. classifier 层对输出做了过小的专用 token 限制，制造截断风险。
3. 降级提示被写成 assistant 消息，污染了对话历史。

## 解决方案

### 1. 无差异路由短路

在 `resolveTurnRouting` 中增加判断：

- 如果 `routing.enabled = true`
- 且 `l0-l3` 都显式等于当前默认 `{ provider, model }`
- 则直接返回默认 adapter/model/provider
- 不调用 classifier
- `intent = null`
- `failed = false`

这样保留了 routing 配置，但避免无收益的分类调用。

### 2. classifier 失败时静默降级

classifier 失败仍然降级到默认模型，但不再把该状态传给聊天消息层：

- 返回默认 adapter/model/provider
- 保留 `error` 给日志或调试使用
- `failed = false`
- 更新 `uiRouting` 为默认 provider/model

### 3. 删除用户可见降级消息

移除 `turnLifecycle` / `turnRunner` 中插入以下消息的逻辑：

```text
⚠ routing failed — using default model
```

原因：这条消息不是模型回答，也不需要用户行动，不应该出现在 assistant 对话内容里。

### 4. 放开 classifier 专用 token 限制

移除 `classifyIntent()` 请求里的 `max_tokens: 128`。

原因：

- Anthropic API 需要输出上限时，adapter 已有默认值。
- classifier 层不应该额外设置很小的专用上限。
- 对会返回 thinking block 的模型，小上限会优先被 thinking 消耗，导致 JSON 截断。

同时将 classifier prompt 改短，明确要求只返回 minified JSON，并限制 `reason` 长度。

## 验证

已验证：

```bash
pnpm --filter @open-vera/core exec vitest run \
  tests/repl-ui-routing.test.ts \
  tests/repl-ui-turn-lifecycle.test.ts \
  tests/repl-ui-turn-runner.test.ts
```

结果：

```text
Test Files  3 passed (3)
Tests       12 passed (12)
```

已验证 core 编译：

```bash
pnpm --filter @open-vera/core build
```

结果：通过。

已用真实 `.vera/settings.json` 和 `mimo-v2.5-pro` 验证以下 prompt 均可成功分类：

```text
接下来跑一下这个项目启动试试看好用吗
main 拉到auto/r6最新位置,然后合入 feature 分支代码
'/Users/yang.zhou/workspace/open-vera/.vera/settings.json' 配置上应该是没问题的
```

已用 TTY 启动 REPL：

```bash
pnpm run dev
```

结果：

- core build 通过
- REPL 正常进入首页
- 首页显示 `mimo / mimo-v2.5-pro`
- 启动阶段不再出现 `routing failed — using default model`

补充：直接在非 TTY 管道里启动 Ink REPL 会触发 raw mode 问题；这是运行方式问题，不是本 case 的根因。

## 经验沉淀

- `routing.enabled = true` 不代表每轮都必须调用 classifier；如果所有路由目标相同，分类没有价值。
- 不要在 classifier 层随手设置过小 `max_tokens`；尤其是支持 thinking block 的模型，输出预算不等于最终可解析文本预算。
- 如果确实要限制成本，优先压缩 prompt 和输出 schema，而不是截断 JSON。
- 降级逻辑应该优先保证主流程可用，但不应把内部 fallback 状态伪装成 assistant 消息。
- 用户说“配置没问题”时，要验证配置结构，再检查控制流是否对该配置形态做了不必要工作。
- 对 LLM 调用要做收益判断：无收益调用会带来成本、延迟和额外失败面。
- 用户可见提示要有行动价值；没有行动价值的诊断信息应进入日志、debug 状态或测试断言。
