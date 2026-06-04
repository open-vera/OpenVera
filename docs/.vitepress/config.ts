import { defineConfig } from "vitepress";

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
    text: "📖 使用手册",
    collapsed: false,
    items: [
      { text: "安装与配置", link: "/core/config" },
      { text: "CLI 命令参考", link: "/core/cli-reference" },
      { text: "Flow 配置与使用", link: "/harness/flow-guide" },
      { text: "模型路由配置", link: "/core/intent-routing" },
      { text: "Session 管理", link: "/core/session" },
      { text: "权限系统", link: "/core/permission" },
    ],
  },
  {
    text: "🧠 Core — Agent 运行时",
    collapsed: true,
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
      { text: "Skill 系统", link: "/core/skill-authoring-guide" },
      { text: "Skill 进化", link: "/core/skill-evolution" },
      { text: "Session 系统", link: "/core/session" },
      { text: "权限系统", link: "/core/permission" },
      { text: "项目上下文", link: "/core/project-context" },
      { text: "自定义 Agent", link: "/core/agent-definitions" },
      { text: "操作录制", link: "/core/operation-recorder" },
      { text: "Worktree 管理", link: "/core/worktree" },
      { text: "配置 & 路径", link: "/core/config" },
      { text: "能力差距", link: "/core/capability-gaps" },
      { text: "P0 对齐清单", link: "/core/p0-alignment-checklist" },
    ],
  },
  {
    text: "⚙️ Harness — 执行内核",
    collapsed: true,
    items: [
      { text: "总览", link: "/harness/README" },
      { text: "设计 (6 原则)", link: "/harness/design" },
      { text: "架构", link: "/harness/architecture" },
      { text: "Runtime 实现", link: "/harness/runtime-implementation" },
      { text: "Flow 配置与使用", link: "/harness/flow-guide" },
      { text: "蜂群 Swarm", link: "/harness/swarm" },
      { text: "自进化管道", link: "/harness/self-evolution" },
      { text: "技术选型", link: "/harness/tech-selection" },
      { text: "MVP PRD", link: "/harness/mvp-prd" },
      { text: "实施方案", link: "/harness/implementation" },
    ],
  },
  {
    text: "🖥️ Gateway — Web 管理端",
    collapsed: true,
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
    text: "🧩 平台能力",
    collapsed: true,
    items: [
      { text: "平台总览", link: "/platform/README" },
      { text: "插件生命周期", link: "/plugin-lifecycle" },
      { text: "Computer Use", link: "/platform/computer-use" },
      { text: "多 Agent 网络", link: "/platform/multi-agent-network" },
      { text: "MCP 支持", link: "/platform/mcp" },
      { text: "RAG 检索增强", link: "/platform/rag" },
      { text: "Sandbox 沙箱", link: "/platform/sandbox" },
      { text: "Channel 适配器", link: "/platform/channel" },
      { text: "Storage 存储", link: "/platform/storage" },
      { text: "Loaders 加载器", link: "/core/loaders" },
      { text: "应用总览", link: "/apps/README" },
    ],
  },
  {
    text: "📊 评测 & 治理",
    collapsed: true,
    items: [
      { text: "评测总览", link: "/eval/README" },
      { text: "Benchmark 设计", link: "/eval/benchmark" },
      { text: "测试覆盖率", link: "/eval/test-coverage" },
      { text: "代码治理规范", link: "/code-governance/README" },
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
  srcExclude: ["zh/refrence/**"],
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
