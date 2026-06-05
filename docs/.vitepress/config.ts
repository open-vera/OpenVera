import { defineConfig } from "vitepress";

const sidebarEn = [
  {
    text: "🚀 Getting Started",
    collapsed: false,
    items: [
      { text: "Install & Setup", link: "/guide/install" },
      { text: "CLI Reference", link: "/guide/cli" },
      { text: "Model Routing", link: "/guide/routing" },
      { text: "Session Management", link: "/guide/session" },
      { text: "Flow Configuration", link: "/guide/flow" },
      { text: "Permission System", link: "/guide/permission" },
    ],
  },
  {
    text: "📖 Overview & Reference",
    collapsed: true,
    items: [
      { text: "Documentation", link: "/README" },
      { text: "Architecture", link: "/architecture" },
      { text: "Roadmap", link: "/roadmap" },
      { text: "Changelog", link: "/changelog" },
      { text: "v0.3.1 Release Notes", link: "/releases/v0.3.1" },
    ],
  },
  {
    text: "🧠 Core — Agent Runtime",
    collapsed: true,
    items: [
      { text: "Agent Design", link: "/core/agent" },
      { text: "Runtime Design", link: "/core/runtime" },
      { text: "Plan Mode", link: "/core/plan-mode" },
      { text: "Infinite Context & Compression", link: "/core/compression" },
      { text: "Subagent System", link: "/core/subagent" },
      { text: "Tool Runtime", link: "/core/tool-runtime" },
      { text: "Tool System", link: "/core/tools" },
      { text: "Tool Rendering", link: "/core/tool-render" },
      { text: "Skill System", link: "/core/skill" },
      { text: "Skill Evolution", link: "/core/skill-evo" },
      { text: "Session System", link: "/core/session" },
      { text: "Project Context", link: "/core/project-ctx" },
      { text: "Custom Agent", link: "/core/agent-def" },
      { text: "Operation Recorder", link: "/core/op-recorder" },
      { text: "Worktree Management", link: "/core/worktree" },
      { text: "Loaders", link: "/core/loaders" },
      { text: "Logger", link: "/core/logger" },
      { text: "Shared Package", link: "/core/shared" },
    ],
  },
  {
    text: "⚙️ Harness — Execution Kernel",
    collapsed: true,
    items: [
      { text: "Overview", link: "/harness/overview" },
      { text: "Design (6 Principles)", link: "/harness/design" },
      { text: "Runtime Implementation", link: "/harness/runtime" },
      { text: "Swarm", link: "/harness/swarm" },
      { text: "Evolution Pipeline", link: "/harness/evolution" },
      { text: "MVP Implementation", link: "/harness/impl" },
      { text: "Multi-Agent Collaboration", link: "/harness/mvp" },
      { text: "Tech Stack", link: "/harness/tech" },
    ],
  },
  {
    text: "🖥️ Gateway — Web Console",
    collapsed: true,
    items: [
      { text: "Control Plane", link: "/gateway/control" },
      { text: "Harness UI Design", link: "/gateway/harness-ui" },
      { text: "UI Refinement", link: "/gateway/ui-refine" },
      { text: "TUI Overview", link: "/gateway/tui" },
      { text: "TUI (Ink)", link: "/gateway/tui-ink" },
      { text: "TUI (OpenTUI)", link: "/gateway/tui-opentui" },
    ],
  },
  {
    text: "🧩 Platform Capabilities",
    collapsed: true,
    items: [
      { text: "Platform Overview", link: "/platform/overview" },
      { text: "Plugin Lifecycle", link: "/platform/plugin" },
      { text: "Computer Use", link: "/platform/computer-use" },
      { text: "Multi-Agent Network", link: "/platform/multi-agent" },
      { text: "MCP Support", link: "/platform/mcp" },
      { text: "RAG", link: "/platform/rag" },
      { text: "Sandbox", link: "/platform/sandbox" },
      { text: "Channel Adapter", link: "/platform/channel" },
      { text: "Storage", link: "/platform/storage" },
    ],
  },
  {
    text: "📊 Evaluation & Governance",
    collapsed: true,
    items: [
      { text: "Overview", link: "/governance/overview" },
      { text: "Benchmark Design", link: "/governance/benchmark" },
      { text: "Test Coverage", link: "/governance/coverage" },
      { text: "Code Style & Governance", link: "/governance/code-style" },
      { text: "Static Analysis", link: "/governance/static" },
      { text: "Storage Test Coverage", link: "/governance/storage-test" },
    ],
  },
];

const sidebarZh = [
  {
    text: "🚀 快速开始",
    collapsed: false,
    items: [
      { text: "安装与配置", link: "/zh/guide/install" },
      { text: "CLI 命令参考", link: "/zh/guide/cli" },
      { text: "模型路由", link: "/zh/guide/routing" },
      { text: "Session 管理", link: "/zh/guide/session" },
      { text: "Flow 配置与使用", link: "/zh/guide/flow" },
      { text: "权限系统", link: "/zh/guide/permission" },
    ],
  },
  {
    text: "📖 总览与参考",
    collapsed: true,
    items: [
      { text: "文档总览", link: "/zh/README" },
      { text: "架构概览", link: "/zh/architecture" },
      { text: "路线图", link: "/zh/roadmap" },
      { text: "变更日志", link: "/zh/changelog" },
      { text: "v0.3.1 发布说明", link: "/zh/releases/v0.3.1" },
    ],
  },
  {
    text: "🧠 Core — Agent 运行时",
    collapsed: true,
    items: [
      { text: "Agent 设计", link: "/zh/core/agent" },
      { text: "Runtime 设计", link: "/zh/core/runtime" },
      { text: "Plan Mode", link: "/zh/core/plan-mode" },
      { text: "无限上下文 & 压缩", link: "/zh/core/compression" },
      { text: "Subagent 系统", link: "/zh/core/subagent" },
      { text: "Tool Runtime", link: "/zh/core/tool-runtime" },
      { text: "工具系统", link: "/zh/core/tools" },
      { text: "Tool 渲染", link: "/zh/core/tool-render" },
      { text: "Skill 系统", link: "/zh/core/skill" },
      { text: "Skill 进化", link: "/zh/core/skill-evo" },
      { text: "Session 系统", link: "/zh/core/session" },
      { text: "项目上下文", link: "/zh/core/project-ctx" },
      { text: "自定义 Agent", link: "/zh/core/agent-def" },
      { text: "操作录制", link: "/zh/core/op-recorder" },
      { text: "Worktree 管理", link: "/zh/core/worktree" },
      { text: "Loaders 加载器", link: "/zh/core/loaders" },
      { text: "Logger 日志系统", link: "/zh/core/logger" },
      { text: "Shared 共享包", link: "/zh/core/shared" },
    ],
  },
  {
    text: "⚙️ Harness — 执行内核",
    collapsed: true,
    items: [
      { text: "总览", link: "/zh/harness/overview" },
      { text: "设计 (6 原则)", link: "/zh/harness/design" },
      { text: "Runtime 实现", link: "/zh/harness/runtime" },
      { text: "蜂群 Swarm", link: "/zh/harness/swarm" },
      { text: "自进化管道", link: "/zh/harness/evolution" },
      { text: "MVP 实现记录", link: "/zh/harness/impl" },
      { text: "多 Agent 协作方案", link: "/zh/harness/mvp" },
      { text: "技术选型", link: "/zh/harness/tech" },
    ],
  },
  {
    text: "🖥️ Gateway — Web 管理端",
    collapsed: true,
    items: [
      { text: "控制面设计", link: "/zh/gateway/control" },
      { text: "Harness UI 方案", link: "/zh/gateway/harness-ui" },
      { text: "UI 优化方案", link: "/zh/gateway/ui-refine" },
      { text: "TUI 总览", link: "/zh/gateway/tui" },
      { text: "TUI (Ink)", link: "/zh/gateway/tui-ink" },
      { text: "TUI (OpenTUI)", link: "/zh/gateway/tui-opentui" },
    ],
  },
  {
    text: "🧩 平台能力",
    collapsed: true,
    items: [
      { text: "平台总览", link: "/zh/platform/overview" },
      { text: "插件生命周期", link: "/zh/platform/plugin" },
      { text: "插件实施计划", link: "/zh/platform/plugin-implementation-plan" },
      { text: "Computer Use", link: "/zh/platform/computer-use" },
      { text: "多 Agent 网络", link: "/zh/platform/multi-agent" },
      { text: "MCP 支持", link: "/zh/platform/mcp" },
      { text: "RAG 检索增强", link: "/zh/platform/rag" },
      { text: "Sandbox 沙箱", link: "/zh/platform/sandbox" },
      { text: "Channel 适配器", link: "/zh/platform/channel" },
      { text: "Storage 存储", link: "/zh/platform/storage" },
    ],
  },
  {
    text: "📊 评测 & 治理",
    collapsed: true,
    items: [
      { text: "评测总览", link: "/zh/governance/overview" },
      { text: "Benchmark 设计", link: "/zh/governance/benchmark" },
      { text: "测试覆盖率", link: "/zh/governance/coverage" },
      { text: "代码治理规范", link: "/zh/governance/code-style" },
      { text: "静态分析", link: "/zh/governance/static" },
      { text: "Storage 测试覆盖", link: "/zh/governance/storage-test" },
    ],
  },
];

export default defineConfig({
  base: "/OpenVera/",
  ignoreDeadLinks: true,
  head: [["link", { rel: "icon", href: "/OpenVera/favicon.png" }]],

  markdown: {
    config: (md) => { md.set({ html: false }); },
  },

  locales: {
    root: {
      label: "English", lang: "en-US",
      title: "OpenVera",
      description: "Harness-native agent runtime",
      themeConfig: {
        logo: "/favicon.png",
        nav: [
          { text: "Home", link: "/" },
          { text: "Docs", link: "/README" },
          { text: "Roadmap", link: "/roadmap" },
        ],
        sidebar: sidebarEn,
      },
    },
    zh: {
      label: "中文", lang: "zh-CN",
      title: "OpenVera",
      description: "以 Harness 为内核的 agent runtime",
      themeConfig: {
        logo: "/favicon.png",
        nav: [
          { text: "首页", link: "/zh/" },
          { text: "文档", link: "/zh/README" },
          { text: "路线图", link: "/zh/roadmap" },
        ],
        sidebar: sidebarZh,
      },
    },
  },

  themeConfig: {
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/open-vera/OpenVera" },
    ],
  },
});
