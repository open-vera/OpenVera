# change-query Skill

Query the agent change tracking database to understand project modification history.

## Usage

Use this skill when you need to:
- Understand what files were recently modified by agents
- Find out which tools were used and how often
- Track changes to specific files over time
- Get a summary of recent agent activity

## Query Modes

### Recent Changes
Query changes from the last N hours:
```
"Show me changes from the last 2 hours"
"What was modified today?"
```

### File History
Query changes to a specific file:
```
"What changes were made to src/index.ts?"
"Who modified the config file?"
```

### Agent Activity
Query a specific agent's operations:
```
"What did agent-1 do recently?"
"Show me all bash commands run by the agent"
```

### Tool Statistics
Query tool usage patterns:
```
"How many times was write_file used today?"
"What tools were used most frequently?"
```

## Output Format

Results are displayed as a markdown table:

| Time | Agent | Tool | Files | Summary |
|------|-------|------|-------|---------|
| 2026-05-27 14:30 | agent-1 | write_file | src/index.ts | Wrote src/index.ts |
| 2026-05-27 14:25 | agent-1 | bash | - | Executed: pnpm test |

## Implementation

The change tracking system stores records in `~/.vera/changes/YYYY-MM-DD.jsonl` files.
Each record contains:
- `timestamp`: ISO timestamp of the tool call
- `agentId`: Which agent made the call
- `toolName`: Name of the tool used
- `args`: Tool arguments (truncated)
- `success`: Whether the call succeeded
- `filesChanged`: List of files modified
- `summary`: Human-readable summary
- `resultPreview`: Preview of the result (truncated)

## Integration

To enable change tracking in your agent runtime:
```typescript
import { ChangeTracker } from "@open-vera/openvera/tracking";

const tracker = new ChangeTracker({ agentId: "my-agent" });
await tracker.initialize();

// Register as middleware
registry.use(tracker.createMiddleware());
```
