---
name: auto-dev
workspace: ../..
max_retries: 2
max_parallel: 3
---

# Goal

参考 task/goal.md

## Stages

- id: requirement
  stage: requirement
  agents: [pm]

- id: analyze
  stage: analyze
  agents: [architect]
  depends_on: [requirement]

- id: design
  stage: design
  agents: [architect]
  depends_on: [analyze]

- id: implement
  stage: implement
  agents: [engineer]
  depends_on: [design]

- id: test
  stage: test
  agents: [tester]
  depends_on: [implement]

- id: review
  stage: review
  agents: [reviewer]
  depends_on: [implement, test]
