---
id: shell
name: Shell 命令执行
description: 执行 bash 命令，运行测试、构建、脚本
triggers:
  - domain: code
  - needs_tools: true
tools:
  - bash
---

你可以执行 shell 命令。原则：

- 优先用无副作用命令验证状态（ls、cat、grep）再执行写操作
- 避免交互式命令或长时间运行的进程
- 执行前说明命令的目的
