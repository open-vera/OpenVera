# Skill Evolution System

The skill evolution system enables Vera's skills to self-optimize over time. Through post-execution reflection, version management, and training framework integration, skills can learn and improve from real-world usage.

---

## 1. Architecture Overview

```
Skill Execution
    │
    ▼
SkillReflector                   ← LLM analyzes execution quality, identifies issues
    │
    ▼
VersionManager                   ← Determines version number from bumpType
    │
    └─ major (breaking change) → 1.0.0 → 2.0.0
    └─ minor (feature)         → 1.0.0 → 1.1.0
    └─ patch (fix)             → 1.0.0 → 1.0.1

SkillAutoCreator                ← Extracts reusable templates from execution history
    │
    ▼
SkillFilter                     ← Controls which skills are allowed to evolve
    │
    ▼
SkillOptAdapter                 ← Connects to Python training framework for deep optimization
```

---

## 2. SkillReflector

SkillReflector is the core component of skill evolution. After a skill executes, it calls an LLM to analyze execution quality and produce structured reflection.

**Source:** `packages/core/src/skill-evolution/skill-reflector.ts`

### 2.1 How It Works

`SkillReflector.reflect(skillName, skillContent, executionMessages)` performs the following flow:

1. **Read skill content**: Get the full text of SKILL.md
2. **Build execution transcript**: Compress user/assistant messages from the message history into a summary (max 300 chars per message)
3. **Call LLM for evaluation**: Send a system prompt + skill content + transcript summary (each truncated to 3000 chars)
4. **Parse structured feedback**: Extract JSON from the LLM response, validate, and return `SkillReflection`

### 2.2 Evaluation Dimensions

The LLM evaluates skill quality across four dimensions:

| Dimension | What it evaluates | Example issue |
|-----------|------------------|---------------|
| **Clarity** | Are instructions unambiguous? Can an agent follow them without guessing? | "Step 3 does not specify which file path to use" |
| **Coverage** | Are edge cases handled? Are there missing error scenarios? | "Does not handle API returning 429" |
| **Correctness** | Do the steps produce the expected outcome? | "Step 2 output format is incompatible with downstream" |
| **Efficiency** | Are there unnecessary steps or redundant checks? | "Step 4 and step 6 do the same thing" |

### 2.3 Output Structure

```typescript
interface SkillReflection {
  skillName: string;
  qualityScore: number;            // 0-1 overall quality score
  issues: ReflectionIssue[];       // Issues found
  needsUpdate: boolean;            // Whether the skill needs updates
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

- **qualityScore**: Parsed from LLM response, clamped to 0-1. Defaults to 0.5 on parse failure.
- **needsUpdate**: LLM-explicit `needsUpdate` takes priority; otherwise determined by `qualityScore < minQuality` (default 0.8).
- **bumpType**: LLM-explicit value takes priority; otherwise inferred from issue severity:
  - Any `high` severity issue → `major`
  - Any `medium` severity issue → `minor`
  - Only `low` severity issues → `patch`

### 2.5 Usage Example

```typescript
const reflector = new SkillReflector({
  adapter: new AnthropicAdapter({ apiKey: "..." }),
  model: "claude-sonnet-4-6",
  minQuality: 0.8,
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

Reflection triggers are controlled by the upper Harness layer (not inside SkillReflector):

- Auto-triggered after each skill execution (configurable threshold)
- Triggered when a skill's consecutive failure count reaches a threshold
- Periodic batch reflection on active skills
- Manually triggered via CLI or API

---

## 3. SkillAutoCreator

SkillAutoCreator automatically extracts reusable skill templates from agent execution history.

**Source:** `packages/core/src/skill-evolution/types.ts`

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
  minRounds?: number;       // Minimum task rounds before extraction (default 3)
  minConfidence?: number;   // Minimum confidence to output a template (default 0.6)
  adapter: LLMAdapter;
  model: string;
}
```

- If execution rounds are below `minRounds`, `triggered = false` and no extraction occurs.
- Only templates with confidence >= `minConfidence` are output.

---

## 4. VersionManager

The version manager tracks semantic versioning and change history for each skill.

**Source:** `packages/core/src/skill-evolution/types.ts`

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

Version bumps follow semantic versioning:
- **major**: Breaking changes (e.g., removing steps, changing output format)
- **minor**: Backward-compatible new features (e.g., new edge case coverage)
- **patch**: Fix-level changes (e.g., wording improvements, boundary handling)

---

## 5. SkillFilter

SkillFilter controls which skills are eligible for automatic evolution, preventing accidental modification of system built-in skills.

**Source:** `packages/core/src/skill-evolution/types.ts`

```typescript
type SkillOrigin = "system" | "brand" | "user" | "marketplace";

interface SkillMetadata {
  name: string;
  origin: SkillOrigin;      // Where the skill came from
  evolvable: boolean;       // Whether evolution is allowed
}

interface FilterOptions {
  evolvableOrigins?: SkillOrigin[];  // Default: ["user", "marketplace"]
}
```

**Default policy:** Only skills from `user` and `marketplace` origins can evolve. `system` and `brand` skills are protected to prevent automatic modification of core framework skills.

---

## 6. SkillOptAdapter

SkillOptAdapter connects to the Python training framework SkillOpt, which trains agent skills like neural networks using epochs, batch sizes, and validation gates.

**Source:** `packages/harness/src/training/skill-opt-adapter.ts`

### 6.1 Training Flow

```typescript
const adapter = new SkillOptAdapter({
  skillOptPath: "/path/to/skill-opt",
  optimizerModel: "claude-opus-4-7",  // Optimizer model (improves the skill)
  targetModel: "claude-sonnet-4-6",   // Target model (being trained)
  numEpochs: 5,       // Number of training epochs
  batchSize: 8,       // Batch size
  workers: 4,         // Parallel workers
  learningRate: 0.1,  // Learning rate
});

const run = await adapter.train(dataDir, "my-skill-v2");
// run: { runName, status, currentEpoch, totalEpochs, history, bestSkill }
```

### 6.2 Training State

```typescript
interface TrainingRun {
  runName: string;
  outputDir: string;                         // Output directory
  status: "pending" | "running" | "completed" | "failed";
  currentEpoch: number;
  totalEpochs: number;
  bestSkill?: string;                        // Best skill content from training
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

Evaluate an existing skill without training:

```typescript
const evalResult = await adapter.evaluate(
  "/path/to/skill.md",     // Skill file path
  "/path/to/data",          // Evaluation data directory
  "valid_unseen",           // Evaluation mode
);
// evalResult: { mode, passRate, accuracy, avgSteps, cases }
```

Evaluation modes: `valid_unseen`, `valid_seen`, `train`, `all`.

### 6.4 Runtime

SkillOptAdapter internally invokes SkillOpt's `train.py` and `eval_only.py` scripts via a `python3` subprocess:
- Training timeout: 1 hour (3600000ms)
- Evaluation timeout: 10 minutes (600000ms)
- After training, the best skill is extracted from `outputDir/best_skill.md`
- Training history is parsed from `outputDir/history.json`

### 6.5 Configuration

```typescript
interface SkillOptConfig {
  skillOptPath: string;        // Path to SkillOpt installation (required)
  optimizerModel: string;      // Optimizer model (required)
  targetModel: string;         // Target model being trained (required)
  numEpochs?: number;          // Default: 5
  batchSize?: number;          // Default: 8
  workers?: number;            // Default: 4
  learningRate?: number;       // Default: 0.1
  apiKey?: string;             // API key for optimizer model
  apiBaseUrl?: string;         // Custom API endpoint
}
```

---

## 7. Evolution Trigger Strategies

| Trigger | Description |
|---------|-------------|
| **Post-execution auto-reflection** | SkillReflector runs automatically after each skill execution |
| **Failure rate threshold** | Deep analysis triggered when a skill's failure rate exceeds a threshold |
| **Periodic review** | Scheduled batch reflection on all active skills |
| **Manual trigger** | Developer explicitly triggers evolution via CLI or API |

---

## 8. Current Status

The skill evolution system is part of **Phase 20D** (OC13-OC16):

| Component | Status | Notes |
|-----------|--------|-------|
| SkillAutoCreator (OC13) | Types defined | Interface and types ready; LLM-driven template extraction logic pending |
| SkillReflector (OC14) | Implemented | LLM-driven post-execution reflection with four-dimension evaluation and structured output |
| VersionManager (OC15) | Types defined | Data structures for semantic versioning and change history ready |
| SkillFilter (OC16) | Types defined | Origin-based filtering rules for evolution permission control ready |
| SkillOptAdapter | Implemented | Python training framework integration, supports training and evaluation modes |

### 8.1 Relationship to Self-Evolution Pipeline

Skill evolution is a subset of the broader self-evolution pipeline:
- DreamingRunner can produce `type: "skill"` proposals
- SkillReflector provides execution quality signals that can feed into Dreaming as experience input
- SkillOptAdapter provides deep optimization capability (iterative training rather than one-off prompt adjustment)
- The actual strategy for each task domain in StrategyStore can be a specific version of a skill
