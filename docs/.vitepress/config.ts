import { defineConfig } from "vitepress";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// Fallback plugin: if a page doesn't exist under a locale (e.g., docs/zh/foo.md),
// rewrite the request to the root locale (docs/foo.md) so both languages can
// access all docs without duplicating files.
function localeFallback(): Plugin {
  const DOCS_DIR = resolve(__dirname, "../");
  return {
    name: "vitepress-locale-fallback",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        // Rewrite /zh/some-page to /some-page if zh version doesn't exist
        if (req.url?.startsWith("/zh/") && !req.url.startsWith("/zh/index")) {
          const zhPath = resolve(DOCS_DIR, "zh", req.url.slice(4).replace(/\.html?$/, "") + ".md");
          try {
            statSync(zhPath);
          } catch {
            // zh file doesn't exist, rewrite URL to root locale
            const origUrl = req.url;
            req.url = req.url.slice(3); // remove /zh prefix
            if (req.url === "/") req.url = "/index";
            console.log(`  [fallback] ${origUrl} → ${req.url}`);
          }
        }
        next();
      });
    },
  };
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

  vite: {
    plugins: [localeFallback()],
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
        sidebar: [
          {
            text: "🚀 Quick Start",
            items: [
              { text: "Overview", link: "/README" },
              { text: "Architecture", link: "/architecture" },
              { text: "Roadmap", link: "/roadmap" },
              { text: "Changelog", link: "/changelog" },
              { text: "v0.3.1 Release", link: "/releases/v0.3.1" },
              { text: "v0.2.0 Release", link: "/releases/v0.2.0" },
            ],
          },
          {
            text: "🧠 Core — Agent Runtime",
            collapsed: false,
            items: [
              { text: "Overview", link: "/core/README" },
              { text: "Agent Design", link: "/core/agent-design" },
              { text: "Runtime Design", link: "/core/runtime-design" },
              { text: "Intent Routing (L0-L2)", link: "/core/intent-routing" },
              { text: "Plan Mode", link: "/core/plan-mode-implementation" },
              { text: "Infinite Context", link: "/core/infinite-context-implementation" },
              { text: "Subagent System", link: "/core/subagent-design" },
              { text: "Tool System", link: "/core/tool-runtime" },
              { text: "Tool Rendering", link: "/core/tool-rendering" },
              { text: "Skill Integration", link: "/core/skill-tool-integration" },
              { text: "Skill Authoring Guide", link: "/core/skill-authoring-guide" },
              { text: "Session Mechanism", link: "/core/claude-code-session-mechanism" },
              { text: "P0 Alignment Checklist", link: "/core/p0-alignment-checklist" },
              { text: "Capability Gaps", link: "/core/capability-gaps" },
            ],
          },
          {
            text: "⚙️ Harness — Execution Kernel",
            collapsed: false,
            items: [
              { text: "Overview", link: "/harness/README" },
              { text: "Design (6 Principles)", link: "/harness/design" },
              { text: "Architecture", link: "/harness/architecture" },
              { text: "Runtime Implementation", link: "/harness/runtime-implementation" },
              { text: "Tech Selection", link: "/harness/tech-selection" },
              { text: "MVP PRD", link: "/harness/mvp.prd" },
              { text: "Implementation Plan", link: "/harness/实施" },
            ],
          },
          {
            text: "🖥️ Gateway — Web UI",
            collapsed: false,
            items: [
              { text: "Gateway Control Plane", link: "/gateway-control-plane" },
              { text: "Harness UI Plan", link: "/harness-ui-plan" },
              { text: "UI Refinement Plan", link: "/ui-refinement-plan" },
              { text: "TUI Overview", link: "/tui/README" },
              { text: "Ink Evolution", link: "/tui/ink-evolution" },
              { text: "OpenTUI Rewrite", link: "/tui/opentui-rewrite" },
            ],
          },
          {
            text: "🧩 Platform & Plugins",
            collapsed: false,
            items: [
              { text: "Platform Overview", link: "/platform/README" },
              { text: "Plugin Lifecycle", link: "/plugin-lifecycle" },
              { text: "Computer Use", link: "/platform/computer-use" },
              { text: "Intelligent Testing", link: "/platform/intelligent-testing" },
              { text: "Apps Overview", link: "/apps/README" },
            ],
          },
          {
            text: "📊 Eval & Quality",
            collapsed: false,
            items: [
              { text: "Eval Overview", link: "/eval/README" },
              { text: "Benchmark Design", link: "/eval/benchmark" },
              { text: "Static Analysis", link: "/code-governance/static-analysis" },
              { text: "Storage Testing", link: "/testing/storage/README" },
              { text: "Agent Review", link: "/agent-review/README" },
            ],
          },
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
          { text: "文档", link: "/zh/README" },
          { text: "路线图", link: "/zh/roadmap" },
          { text: "变更日志", link: "/zh/changelog" },
        ],
        sidebar: [
          {
            text: "🚀 快速开始",
            items: [
              { text: "总览", link: "/zh/README" },
              { text: "架构概览", link: "/zh/architecture" },
              { text: "路线图", link: "/zh/roadmap" },
              { text: "变更日志", link: "/zh/changelog" },
              { text: "v0.3.1 发布", link: "/zh/releases/v0.3.1" },
              { text: "v0.2.0 发布", link: "/zh/releases/v0.2.0" },
            ],
          },
          {
            text: "🧠 Core — Agent 运行时",
            collapsed: false,
            items: [
              { text: "总览", link: "/zh/core/README" },
              { text: "Agent 设计", link: "/zh/core/agent-design" },
              { text: "Runtime 设计", link: "/zh/core/runtime-design" },
              { text: "意图路由 (L0-L2)", link: "/zh/core/intent-routing" },
              { text: "Plan Mode", link: "/zh/core/plan-mode-implementation" },
              { text: "无限上下文", link: "/zh/core/infinite-context-implementation" },
              { text: "Subagent 系统", link: "/zh/core/subagent-design" },
              { text: "工具系统", link: "/zh/core/tool-runtime" },
              { text: "工具渲染", link: "/zh/core/tool-rendering" },
              { text: "Skill 集成", link: "/zh/core/skill-tool-integration" },
              { text: "Skill 编写指南", link: "/zh/core/skill-authoring-guide" },
              { text: "Session 机制", link: "/zh/core/claude-code-session-mechanism" },
              { text: "P0 对齐清单", link: "/zh/core/p0-alignment-checklist" },
              { text: "能力差距", link: "/zh/core/capability-gaps" },
            ],
          },
          {
            text: "⚙️ Harness — 执行内核",
            collapsed: false,
            items: [
              { text: "总览", link: "/zh/harness/README" },
              { text: "设计 (6 原则)", link: "/zh/harness/design" },
              { text: "架构", link: "/zh/harness/architecture" },
              { text: "Runtime 实现", link: "/zh/harness/runtime-implementation" },
              { text: "技术选型", link: "/zh/harness/tech-selection" },
              { text: "MVP PRD", link: "/zh/harness/mvp.prd" },
              { text: "实施方案", link: "/zh/harness/实施" },
            ],
          },
          {
            text: "🖥️ Gateway — Web 管理端",
            collapsed: false,
            items: [
              { text: "Gateway 控制面", link: "/zh/gateway-control-plane" },
              { text: "Harness UI 方案", link: "/zh/harness-ui-plan" },
              { text: "UI 优化方案", link: "/zh/ui-refinement-plan" },
              { text: "TUI 总览", link: "/zh/tui/README" },
              { text: "Ink 演进", link: "/zh/tui/ink-evolution" },
              { text: "OpenTUI 切换", link: "/zh/tui/opentui-rewrite" },
            ],
          },
          {
            text: "🧩 平台 & 插件",
            collapsed: false,
            items: [
              { text: "平台总览", link: "/zh/platform/README" },
              { text: "插件生命周期", link: "/zh/plugin-lifecycle" },
              { text: "Computer Use", link: "/zh/platform/computer-use" },
              { text: "智能测试", link: "/zh/platform/intelligent-testing" },
              { text: "应用总览", link: "/zh/apps/README" },
            ],
          },
          {
            text: "📊 评测 & 质量",
            collapsed: false,
            items: [
              { text: "评测总览", link: "/zh/eval/README" },
              { text: "Benchmark 设计", link: "/zh/eval/benchmark" },
              { text: "静态分析", link: "/zh/code-governance/static-analysis" },
              { text: "存储测试", link: "/zh/testing/storage/README" },
              { text: "Agent 审查", link: "/zh/agent-review/README" },
            ],
          },
        ],
      },
    },
  },

  themeConfig: {
    socialLinks: [
      { icon: "github", link: "https://github.com/open-vera/OpenVera" },
    ],
  },
});
