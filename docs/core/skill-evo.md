# Skill Evolution System

Skill Evolution is Vera's mechanism for skills to self-optimize over time. Through post-execution reflection, version management, and training framework integration, skills can learn and improve from actual usage.

---

## 1. Overall Architecture

```
Skill Execution
    │
    ▼
SkillReflector (Reflection)       ← LLM analyzes execution quality, identifies issues
    │
    ▼
VersionManager (Versioning)       ← Determines version number based on bumpType
    │
    └─ major (breaking change) → 1.0.0 → 2.0.0
    └─ minor (feature enhancement) → 1.0.0 → 1.1.0
    └─ patch (fix)               → 1.0.0 → 1.0.1

SkillAutoCreator (Auto-creation)  ← Extracts reusable templates from execution history
    │
    ▼
SkillFilter (Filter)              ← Controls which skills are allowed to evolve
    │
    ▼
SkillOptAdapter (Training)        ← Connects Python training framework for deep optimization
```

---

## 2. SkillReflector

SkillReflector is the core component of skill evolution — it calls an LLM after skill execution to analyze execution quality and produce structured reflections.

**Code location:** `packages/core/src/skill-evolution/skill-reflector.ts`

### 2.1 How It Works

`SkillReflector.reflect(skillName, skillContent, executionMessages)` performs the following flow:

1. **Read skill content**: Gets the full text of SKILL.md
2. **Build execution transcript**: Compresses user/assistant messages from message history into summaries (max 300 characters each)
3. **Call LLM for assessment**: Sends system prompt + skill content + transcript summary (each truncated to 3000 characters)
4. **Parse structured feedback**: Extracts JSON from the LLM response, validates and returns `SkillReflection`

### 2.2 Assessment Dimensions

The LLM assesses skill quality across four dimensions:

| Dimension | What is Assessed | Example Issues |
|-----------|-----------------|----------------|
| **Clarity** | Are instructions unambiguous? Can the agent execute without guessing? | "Step 3 doesn't specify which file path to use" |
| **Coverage** | Are edge cases handled? Are error scenarios missing? | "Does not handle the case when the API returns 429" |
| **Correctness** | Do steps produce expected results? | "Step 2's output format is incompatible with downstream" |
| **Efficiency** | Are there redundant steps or duplicate checks? | "Step 4 and step 6 do the same thing" |

### 2.3 Output Structure

```typescript
interface SkillReflection {
  skillName: string;
  qualityScore: number;            // 0-1, overall quality score
  issues: ReflectionIssue[];       // Issues found
  needsUpdate: boolean;            // Whether an update is needed
  bumpType?: "major" | "minor" | "patch";  // Suggested version bump type
}

interface ReflectionIssue {
  severity: "high" | "medium" | "low";
  category: "clarity" | "coverage" | "correctness" | "efficiency";
  description: string;
  suggestion: string;
}
```

### 2.4 Decision Logic

- **qualityScore**: Parsed from LLM response, clamped to 0-1 range; defaults to 0.5 on parse failure
- **needsUpdate**: Explicit `needsUpdate` from LLM takes priority; otherwise determined by `qualityScore < minQuality` (default 0.8)
- **bumpType**: Explicit from LLM takes priority; otherwise inferred from issue severity:
  - Has `high` severity issue → `major`
  - Has `medium` severity issue → `minor`
  - Only `low` severity issues → `patch`

### 2.5 Usage Example

```typescript
const reflector = new SkillReflector({
  adapter: new AnthropicAdapter({ apiKey: "..." }),
  model: "claude-sonnet-4-6",
  minQuality: 0.8,  // Below this triggers needsUpdate
});

const reflection = await reflector.reflect(
  "deploy-to-prod",
  skillMdContent,
  executionMessages,
);

if (reflection.needsUpdate) {
  console.log(`Skill ${reflection.skillName} needs update (${reflection.bumpType})`);
  for (const issue of reflection.issues) {
    console.log(`  [${issue.severity}] ${issue.category}: ${issue.description}`);
  }
}
```

### 2.6 Trigger Timing

Reflection triggers are controlled by the upper-layer Harness (not inside SkillReflector):

- Automatically triggered after skill execution completes (configurable threshold)
- Triggered when a skill's consecutive failure count reaches a threshold
- Manually triggered (via CLI or API)

---

## 3. SkillAutoCreator

SkillAutoCreator automatically extracts reusable skill templates from agent execution history.

**Code location:** `packages/core/src/skill-evolution/types.ts`

### 3.1 Template Structure

```typescript
interface SkillTemplate {
  name: string;               // Skill name (kebab-case)
  description: string;        // One-line description
  triggers: string[];         // Trigger conditions
  steps: string[];            // Execution steps
  allowedTools: string[];     // Required tools
  argumentHint?: string;      // Argument hint
  sourceTask: string;         // Source task ID
  confidence: number;         // Template reusability confidence (0-1)
}
```

### 3.2 Extraction Conditions

```typescript
interface AutoCreatorOptions {
  minRounds?: number;       // Minimum execution rounds before triggering extraction (default 3)
  minConfidence?: number;   // Minimum confidence for outputting a template (default 0.6)
  adapter: LLMAdapter;
  model: string;
}
```

- When execution rounds are below `minRounds`, `triggered = false`, no extraction occurs
- Only templates with confidence >= `minConfidence` are output

---

## 4. VersionManager

The version manager tracks a skill's semantic version and change history.

**Code location:** `packages/core/src/skill-evolution/types.ts`

### 4.1 Data Structures

```typescript
interface SkillVersion {
  version: string;          // Current version (semver)
  history: VersionEntry[];  // Version history
}

interface VersionEntry {
  version: string;
  changes: string[];        // List of change descriptions
  timestamp: string;
  source: "reflection" | "manual" | "auto-create";
}
```

### 4.2 Version Bump

```typescript
interface VersionUpdateResult {
  updated: boolean;
  previousVersion?: string;
  newVersion?: string;
  changes?: string[];
}
```

Version bumps follow semantic versioning rules:
- **major**: Breaking changes (e.g., removing steps, changing output format)
- **minor**: Backward-compatible new features (e.g., adding coverage scenarios)
- **patch**: Fixes (e.g., wording improvements, edge case handling)

---

## 5. SkillFilter

SkillFilter controls which skills are allowed to participate in automatic evolution, preventing built-in system skills from being accidentally modified.

**Code location:** `packages/core/src/skill-evolution/types.ts`

```typescript
type SkillOrigin = "system" | "brand" | "user" | "marketplace";

interface SkillMetadata {
  name: string;
  origin: SkillOrigin;      // Skill origin
  evolvable: boolean;       // Whether evolution is allowed
}

interface FilterOptions {
  evolvableOrigins?: SkillOrigin[];  // Default: ["user", "marketplace"]
}
```

**Default policy:** Only `user` and `marketplace` origin skills can evolve. `system` and `brand` origin skills are protected, preventing framework core skills from being automatically modified.

---

## 6. SkillOptAdapter

SkillOptAdapter connects to the Python training framework SkillOpt, training agent skills like training neural networks (epoch, batch, validation gate).

**Code location:** `packages/harness/src/training/skill-opt-adapter.ts`

### 6.1 Training Process

```typescript
const adapter = new SkillOptAdapter({
  skillOptPath: "/path/to/skill-opt",
  optimizerModel: "claude-opus-4-7",  // Optimizer model (responsible for improving skills)
  targetModel: "claude-sonnet-4-6",   // Target model (being trained)
  numEpochs: 5,       // Number of training epochs
  batchSize: 8,       // Batch size
  workers: 4,         // Parallel workers
  learningRate: 0.1,  // Learning rate
});

const run = await adapter.train(dataDir, "my-skill-v2");
// run: { runName, status, currentEpoch, totalEpochs, history, bestSkill }
```

### 6.2 Training Status

```typescript
interface TrainingRun {
  runName: string;
  outputDir: string;                         // Output directory
  status: "pending" | "running" | "completed" | "failed";
  currentEpoch: number;
  totalEpochs: number;
  bestSkill?: string;                        // Best skill content produced by training
  history: TrainingEpoch[];                  // Per-epoch metrics
  error?: string;
}

interface TrainingEpoch {
  epoch: number;
  loss: number;
  accuracy: number;
  bestSkillUpdated: boolean;                 // Whether a better skill was found this epoch
  durationMs: number;
}
```

### 6.3 Evaluation Mode

Evaluate existing skills without training:

```typescript
const evalResult = await adapter.evaluate(
  "/path/to/skill.md",     // Skill file path
  "/path/to/data",          // Evaluation data directory
  "valid_unseen",           // Evaluation mode
);
// evalResult: { mode, passRate, accuracy, avgSteps, cases }
```

Evaluation modes:
- `valid_unseen`: New unseen test data
- `valid_seen`: Validation data seen during training
- `train`: Training data
- `all`: All data

### 6.4 Execution Method

SkillOptAdapter internally invokes SkillOpt's `train.py` and `eval_only.py` scripts via `python3` subprocess:
- Training timeout: 1 hour (3600000ms)
- Evaluation timeout: 10 minutes (600000ms)
- After training, extracts the best skill from `outputDir/best_skill.md`
- Training history is parsed from `outputDir/history.json`

### 6.5 Configuration

```typescript
interface SkillOptConfig {
  skillOptPath: string;        // SkillOpt installation directory (required)
  optimizerModel: string;      // Optimizer model (required)
  targetModel: string;         // Target model being trained (required)
  numEpochs?: number;          // Default 5
  batchSize?: number;          // Default 8
  workers?: number;            // Default 4
  learningRate?: number;       // Default 0.1
  apiKey?: string;             // API Key
  apiBaseUrl?: string;         // Custom API endpoint
}
```

---

## 7. Evolution Trigger Strategies

Skill evolution can be triggered through:

| Trigger Method | Description |
|----------------|-------------|
| **Post-execution auto-reflection** | SkillReflector is automatically invoked after each skill execution to analyze quality |
| **Failure rate threshold** | When a skill's failure rate exceeds a threshold, deep analysis is triggered |
| **Periodic review** | Scheduled tasks for batch reflection on active skills |
| **Manual trigger** | Developers manually trigger evolution for specific skills via CLI or API |

---

## 8. Current Status

Skill Evolution System belongs to **Phase 20D** (OC13-OC16):

| Component | Status | Description |
|-----------|--------|-------------|
| SkillAutoCreator (OC13) | Types defined | Interfaces and types ready; LLM-driven template extraction logic pending |
| SkillReflector (OC14) | Implemented | LLM-driven post-execution reflection, four-dimension assessment, structured output |
| VersionManager (OC15) | Types defined | Data structures for semantic versioning and change history ready |
| SkillFilter (OC16) | Types defined | Filter rules for controlling evolution permissions by origin ready |
| SkillOptAdapter | Implemented | Python training framework integration, supports training and evaluation modes |

### 8.1 Relationship with Self-Evolution Pipeline

Skill evolution is a subset of the self-evolution pipeline:
- DreamingRunner can produce `type: "skill"` Proposals
- SkillReflector provides execution quality signals that can serve as experience input for Dreaming
- SkillOptAdapter provides deep optimization capability (iterative training rather than one-shot prompt adjustment)
- The actual strategy for each task domain in StrategyStore can be a specific version of a skill
