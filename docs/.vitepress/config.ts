import { defineConfig } from "vitepress";

// Shared sidebar content — link paths are locale-relative.
// Root locale (zh-CN) uses bare links; /en/ locale prefixes with /en/

const sidebarZh = [
  {
    text: "🚀 快速开始",
    items: [
      { text: "文档总览", link: "/README" },
      { text: "架构概览", link: "/architecture" },
      { text: "路线图", link: "/roadmap" },
      { text: "P0 改进计划", link: "/P0-IMPROVEMENT-PLAN" },
      { text: "P1 实施计划", link: "/P1-IMPLEMENTATION-PLAN" },
      { text: "变更日志", link: "/changelog" },
      { text: "v0.3.1 发布说明", link: "/releases/v0.3.1" },
    ],
  },
  {
    text: "🧠 Core — Agent 运行时",
    collapsed: false,
    items: [
      { text: "总览", link: "/core/README" },
      { text: "Agent 设计", link: "/core/agent-design" },
      { text: "Runtime 设计", link: "/core/runtime-design" },
      { text: "意图路由 (L0-L2)", link: "/core/intent-routing" },
      { text: "Plan Mode", link: "/core/plan-mode-implementation" },
      { text: "无限上下文 & 压缩", link: "/core/infinite-context" },
      { text: "Subagent 系统", link: "/core/subagent-design" },
      { text: "工具系统", link: "/core/tools" },
      { text: "Tool 渲染", link: "/core/tool-rendering" },
      { text: "Skill 集成", link: "/core/skill-tool-integration" },
      { text: "Skill 编写", link: "/core/skill-authoring-guide" },
      { text: "Session 系统", link: "/core/session" },
      { text: "能力差距", link: "/core/capability-gaps" },
      { text: "P0 对齐", link: "/core/p0-alignment-checklist" },
    ],
  },
  {
    text: "⚙️ Harness — 执行内核",
    collapsed: false,
    items: [
      { text: "总览", link: "/harness/README" },
      { text: "设计 (6 原则)", link: "/harness/design" },
      { text: "架构", link: "/harness/architecture" },
      { text: "Runtime 实现", link: "/harness/runtime-implementation" },
      { text: "蜂群 (Swarm)", link: "/harness/swarm" },
      { text: "技术选型", link: "/harness/tech-selection" },
      { text: "设计方案", link: "/harness/implementation" },
      { text: "MVP PRD", link: "/harness/mvp-prd" },
    ],
  },
  {
    text: "🖥️ Gateway — Web 管理端",
    collapsed: false,
    items: [
      { text: "Gateway 控制面", link: "/gateway-control-plane" },
      { text: "Harness UI 方案", link: "/harness-ui-plan" },
      { text: "UI 优化方案", link: "/ui-refinement-plan" },
      { text: "TUI 总览", link: "/tui/README" },
      { text: "Ink 演进", link: "/tui/ink-evolution" },
      { text: "OpenTUI 切换", link: "/tui/opentui-rewrite" },
    ],
  },
  {
    text: "🧩 平台 & 插件",
    collapsed: false,
    items: [
      { text: "平台总览", link: "/platform/README" },
      { text: "插件生命周期", link: "/plugin-lifecycle" },
      { text: "MCP 支持", link: "/platform/mcp" },
      { text: "RAG 系统", link: "/platform/rag" },
      { text: "Sandbox", link: "/platform/sandbox" },
      { text: "Computer Use", link: "/platform/computer-use" },
      { text: "智能测试", link: "/platform/intelligent-testing" },
      { text: "Channel 适配器", link: "/platform/channel" },
      { text: "Storage 存储", link: "/platform/storage" },
      { text: "应用总览", link: "/apps/README" },
    ],
  },
  {
    text: "📊 评测 & 质量",
    collapsed: false,
    items: [
      { text: "评测总览", link: "/eval/README" },
      { text: "Benchmark 设计", link: "/eval/benchmark" },
      { text: "测试覆盖率", link: "/eval/test-coverage" },
      { text: "静态分析", link: "/code-governance/static-analysis" },
      { text: "存储测试", link: "/testing/storage/README" },
      { text: "Agent 审查", link: "/agent-review/README" },
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
  srcExclude: ["refrence/**"],
  head: [["link", { rel: "icon", href: "/OpenVera/favicon.png" }]],

  markdown: {
    config: (md) => {
      md.set({ html: false });
    },
  },

  locales: {
    root: {
      label: "English",
      lang: "en-US",
      title: "OpenVera",
      description: "Harness-native agent runtime — self-planning, self-looping, self-critiquing, self-evolving",
      themeConfig: {
        logo: "/OpenVera/favicon.png",
        nav: [
          { text: "Home", link: "/" },
          { text: "Docs", link: "/README" },
          { text: "Roadmap", link: "/roadmap" },
          { text: "Changelog", link: "/changelog" },
        ],
        sidebar: sidebarZh,
      },
    },
    zh: {
      label: "中文",
      lang: "zh-CN",
      title: "OpenVera",
      description: "以 Harness 为内核、可自规划、自循环、自我批判、自我进化的 agent runtime",
      themeConfig: {
        logo: "/OpenVera/favicon.png",
        nav: [
          { text: "首页", link: "/zh/" },
          { text: "文档", link: "/zh/README" },
          { text: "路线图", link: "/zh/roadmap" },
          { text: "变更日志", link: "/zh/changelog" },
        ],
        sidebar: zhLinks(sidebarZh),
      },
    },
  },

  themeConfig: {
    search: {
      provider: "local",
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/open-vera/OpenVera" },
    ],
  },
});
