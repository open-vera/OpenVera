# Platform -- Platform Extension Capabilities

The Platform layer covers Vera's extensions to broader environments: Computer Use, MCP integration, intelligent UI testing, and more. Corresponds to roadmap P2/P3 phases.

## Document Index

| Document | Content |
|----------|---------|
| [rag.md](./rag.md) | RAG system -- retrieval-augmented generation, embedding, vector store, incremental indexing |
| [sandbox.md](./sandbox.md) | Sandbox isolation -- Docker, CubeSandbox, secure code execution |
| [mcp.md](./mcp.md) | MCP support -- Model Context Protocol client, tool mapping, discovery |
| [channel.md](./channel.md) | Channel system -- multi-platform messaging (CLI, API, Discord, Feishu, etc.) |
| [storage.md](./storage.md) | Storage architecture -- SQLite, key-value abstraction, session/memory persistence |
| [computer-use.md](./computer-use.md) | Computer Use -- browser automation (Playwright/CDP), desktop operation, benchmarks |
| [intelligent-testing.md](./intelligent-testing.md) | Intelligent automated testing -- AI-driven UI testing, multi-strategy element localization, screenshot semantic verification, self-healing tests |

## Pending Documents (P3)

- `multi-agent.md` -- Cross-agent message bus and task scheduling

## Main Package Structure

```
apps/
  harness-ui/      Harness Web UI (Vue + Node server)
    web/           Frontend: runs list, streaming logs, artifact browser
    server/        Backend: REST API, proxies harness runs

packages/
  (Computer Use / MCP client -- pending creation)
```
