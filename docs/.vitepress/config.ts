import { defineConfig } from "vitepress";

const sidebarZh = [
  {
    text: "🚀 快速开始",
    collapsed: false,
    items: [
      { text: "安装与配置", link: "/guide/install" },
      { text: "CLI 命令参考", link: "/guide/cli" },
      { text: "模型路由", link: "/guide/routing" },
      { text: "Session 管理", link: "/guide/session" },
      { text: "Flow 配置与使用", link: "/guide/flow" },
      { text: "权限系统", link: "/guide/permission" },
    ],
  },
  {
    text: "📖 总览与参考",
    collapsed: true,
    items: [
      { text: "文档总览", link: "/README" },
      { text: "架构概览", link: "/architecture" },
      { text: "路线图", link: "/roadmap" },
      { text: "变更日志", link: "/changelog" },
      { text: "v0.3.1 发布说明", link: "/releases/v0.3.1" },
    ],
  },
  {
    text: "🧠 Core — Agent 运行时",
    collapsed: true,
    items: [
      { text: "Agent 设计", link: "/core/agent" },
      { text: "Runtime 设计", link: "/core/runtime" },
      { text: "Plan Mode", link: "/core/plan-mode" },
      { text: "无限上下文 & 压缩", link: "/core/compression" },
      { text: "Subagent 系统", link: "/core/subagent" },
      { text: "Tool Runtime", link: "/core/tool-runtime" },
      { text: "工具系统", link: "/core/tools" },
      { text: "Tool 渲染", link: "/core/tool-render" },
      { text: "Skill 系统", link: "/core/skill" },
      { text: "Skill 进化", link: "/core/skill-evo" },
      { text: "Session 系统", link: "/core/session" },
      { text: "项目上下文", link: "/core/project-ctx" },
      { text: "自定义 Agent", link: "/core/agent-def" },
      { text: "操作录制", link: "/core/op-recorder" },
      { text: "Worktree 管理", link: "/core/worktree" },
      { text: "Loaders 加载器", link: "/core/loaders" },
      { text: "Logger 日志系统", link: "/core/logger" },
      { text: "Shared 共享包", link: "/core/shared" },
    ],
  },
  {
    text: "⚙️ Harness — 执行内核",
    collapsed: true,
    items: [
      { text: "总览", link: "/harness/overview" },
      { text: "设计 (6 原则)", link: "/harness/design" },
      { text: "Runtime 实现", link: "/harness/runtime" },
      { text: "蜂群 Swarm", link: "/harness/swarm" },
      { text: "自进化管道", link: "/harness/evolution" },
      { text: "MVP 实现记录", link: "/harness/impl" },
      { text: "多 Agent 协作方案", link: "/harness/mvp" },
      { text: "技术选型", link: "/harness/tech" },
    ],
  },
  {
    text: "🖥️ Gateway — Web 管理端",
    collapsed: true,
    items: [
      { text: "控制面设计", link: "/gateway/control" },
      { text: "Harness UI 方案", link: "/gateway/harness-ui" },
      { text: "UI 优化方案", link: "/gateway/ui-refine" },
      { text: "TUI 总览", link: "/gateway/tui" },
      { text: "TUI (Ink)", link: "/gateway/tui-ink" },
      { text: "TUI (OpenTUI)", link: "/gateway/tui-opentui" },
    ],
  },
  {
    text: "🧩 平台能力",
    collapsed: true,
    items: [
      { text: "平台总览", link: "/platform/overview" },
      { text: "插件生命周期", link: "/platform/plugin" },
      { text: "Computer Use", link: "/platform/computer-use" },
      { text: "多 Agent 网络", link: "/platform/multi-agent" },
      { text: "MCP 支持", link: "/platform/mcp" },
      { text: "RAG 检索增强", link: "/platform/rag" },
      { text: "Sandbox 沙箱", link: "/platform/sandbox" },
      { text: "Channel 适配器", link: "/platform/channel" },
      { text: "Storage 存储", link: "/platform/storage" },
    ],
  },
  {
    text: "📊 评测 & 治理",
    collapsed: true,
    items: [
      { text: "评测总览", link: "/governance/overview" },
      { text: "Benchmark 设计", link: "/governance/benchmark" },
      { text: "测试覆盖率", link: "/governance/coverage" },
      { text: "代码治理规范", link: "/governance/code-style" },
      { text: "静态分析", link: "/governance/static" },
      { text: "Storage 测试覆盖", link: "/governance/storage-test" },
    ],
  },
];

function zhLinks(items: typeof sidebarZh): typeof sidebarZh {
  return items.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, link: "/zh" + item.link })),
  }));
}

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
        sidebar: sidebarZh,
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
        sidebar: zhLinks(sidebarZh),
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
