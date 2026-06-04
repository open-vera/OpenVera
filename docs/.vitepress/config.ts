import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/OpenVera/",
  ignoreDeadLinks: true,
  srcExclude: ["refrence/**"],

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
        nav: [
          { text: "Home", link: "/" },
          { text: "Docs", link: "/README" },
          { text: "Roadmap", link: "/roadmap" },
          { text: "Changelog", link: "/changelog" },
        ],
      },
    },
    zh: {
      label: "中文",
      lang: "zh-CN",
      title: "OpenVera",
      description: "以 Harness 为内核、可自规划、自循环、自我批判、自我进化的 agent runtime",
      themeConfig: {
        nav: [
          { text: "首页", link: "/zh/" },
          { text: "文档", link: "/README" },
          { text: "路线图", link: "/roadmap" },
          { text: "变更日志", link: "/changelog" },
        ],
      },
    },
  },

  themeConfig: {
    sidebar: [
      {
        text: "Quick Start / 快速开始",
        items: [
          { text: "Docs Overview / 文档总览", link: "/README" },
          { text: "Roadmap / 路线图", link: "/roadmap" },
          { text: "Architecture / 架构", link: "/architecture" },
        ],
      },
      {
        text: "Core — Runtime Foundation",
        collapsed: true,
        items: [
          { text: "Overview", link: "/core/README" },
          { text: "Agent Design", link: "/core/agent-design" },
          { text: "Runtime Design", link: "/core/runtime-design" },
          { text: "Intent Routing", link: "/core/intent-routing" },
          { text: "Subagent Design", link: "/core/subagent-design" },
          { text: "Plan Mode", link: "/core/plan-mode-implementation" },
          { text: "Infinite Context", link: "/core/infinite-context-implementation" },
          { text: "Tool Rendering", link: "/core/tool-rendering" },
          { text: "Tool Runtime", link: "/core/tool-runtime" },
          { text: "Skill Authoring", link: "/core/skill-authoring-guide" },
          { text: "Capability Gaps", link: "/core/capability-gaps" },
          { text: "P0 Alignment", link: "/core/p0-alignment-checklist" },
        ],
      },
      {
        text: "Harness — Execution Kernel",
        collapsed: true,
        items: [
          { text: "Overview", link: "/harness/README" },
          { text: "Design", link: "/harness/design" },
          { text: "Runtime Impl", link: "/harness/runtime-implementation" },
        ],
      },
      {
        text: "Platform",
        collapsed: true,
        items: [
          { text: "Overview", link: "/platform/README" },
          { text: "Computer Use", link: "/platform/computer-use" },
        ],
      },
      {
        text: "Changelog",
        collapsed: true,
        items: [{ text: "Index", link: "/changelog" }],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/open-vera/OpenVera" },
    ],
  },
});
