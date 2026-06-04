# @open-vera/gateway

Control-plane primitives for Vera.

This package aggregates project discovery, capability inventory, and doctor checks for UI/server layers. It does not execute agent work directly; execution stays in `@open-vera/core` and `@open-vera/openvera`.

## Current Surface

- `ProjectRegistry`: discover local Vera projects.
- `CapabilityRegistry`: register and query config, prompt, context, memory, RAG, skill, plugin, MCP, channel, sandbox, flow, conversation, tool, and log capabilities.
- `createProjectCapabilityInventory`: create the default project-scoped capability list.
- `DoctorService`: run read-only checks over projects and capabilities.

## Next Steps

- Add an HTTP server in `apps/gateway-ui/server`.
- Add a unified control console in `apps/gateway-ui/web`.
- Add management actions for safe reload/test/reindex/connect flows.
