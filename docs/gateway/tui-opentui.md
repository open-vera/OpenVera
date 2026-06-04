# OpenTUI Migration Plan

> Vera's current TUI is built with React + Ink (see [tui.md](./tui.md) and [tui-ink.md](./tui-ink.md)). This document evaluates the feasibility and cost of rewriting the terminal UI with OpenTUI, providing a decision basis for future technology selection.

## Background

Vera TUI has accumulated full functionality through multiple iterations -- conversation panel, Diff viewer, Slash command system, Plan Mode visualization, etc. (17 commands, 5 Overlay types, 22 components, approximately 3000+ lines of TSX). On this foundation, any rewrite proposal must answer three core questions:

1. **Functional equivalence**: can it cover all existing capabilities?
2. **Migration cost**: is the rewrite cost lower than incremental evolution?
3. **Long-term benefit**: can the switch resolve Ink's structural limitations?

## OpenTUI Overview

OpenTUI is an emerging terminal UI framework. Compared to Ink's React reconciler approach, it has three notable design differences:

| Dimension | Ink (React Reconciler) | OpenTUI |
|---|---|---|
| Rendering model | React virtual DOM + terminal output diff | Native terminal rendering pipeline, direct ANSI buffer manipulation |
| Component model | JSX components (React lifecycle) | Declarative layout descriptions + imperative draw callbacks |
| State management | React useState / useReducer | Custom reactive Store, no React runtime dependency |
| Event handling | Ink useInput() wrapper | Native stdin event stream + gesture abstraction |
| Dependency footprint | React + Ink + Yoga layout engine | Standalone runtime, no framework dependencies |
| Community maturity | Mature (Ink 5.x, 8k+ stars) | Early stage (API may change) |

**Core advantage**: removing the React middle layer theoretically yields lower input latency, less re-render overhead, smaller dependency footprint, and more direct terminal control.

**Core risk**: functional equivalence requires substantial custom development to fill gaps (virtual scrolling, Diff rendering, theme system, etc.), and the community ecosystem is thin.

## Capability Parity Analysis

### Existing Capability Coverage

| Capability | Ink Status | OpenTUI Implementation Difficulty | Risk |
|---|---|---|---|
| Message list + virtual scrolling | Line Estimation + viewport clipping (~200 lines) | High -- requires custom viewport clipping and line height estimation | Medium |
| InputBar line editing | Composer state machine (pure function, 390 lines) | Mid-layer reusable, upper layer needs rewrite for bindings | Low |
| Syntax-level Diff rendering | Word-level highlighting (~250 lines) | High -- requires custom text coloring and layout | High |
| StatusBar breathing animation | 8-frame orange pulse + timer | Medium -- requires custom frame loop and timer | Low |
| Overlay popup layers | Full-screen overlay + ESC close | Medium -- requires custom stacking and focus management | Medium |
| Slash command system | 17 commands, unified routing | Mid-layer reusable, routing needs rewrite for bindings | Low |
| Theme system | Named tokens + ColorMap | Medium -- needs to redefine color value mapping | Low |
| CJK/IME compatibility | Handled internally by Ink | Uncertain -- OpenTUI wide-char compatibility unverified | High |
| ANSI escape parsing | Custom parser (~150 lines) | Low -- standalone module, directly portable | Low |
| Streaming render buffering | setTimeout 56ms batch increments | Medium -- requires custom ReplayBuffer | Medium |

### Missing Capabilities (Must Build from Scratch)

The following capabilities have mature implementations in the current Ink approach and require completely new implementations in OpenTUI:

1. **Virtual scrolling**: the Ink version's Line Estimation + viewport clipping is a custom solution; moving to OpenTUI requires a full rewrite. Estimated effort: 3-5 person-days.
2. **Diff rendering**: word-level diff highlighting depends on the `diff` library + custom coloring logic. After render layer replacement, the Diff algorithm is reusable, but layout and coloring need rewriting. Estimated effort: 2-3 person-days.
3. **Component library**: OpenTUI has no equivalent of Ink's `Box`/`Text`/`Newline` component system; a basic component abstraction needs to be built. Estimated effort: 3-5 person-days.
4. **Overlay management system**: full-screen popups + z-index + focus preemption, currently implemented with React Context + useState; rewriting requires a custom state machine. Estimated effort: 1-2 person-days.
5. **Theme and style system**: CSS-like style inheritance and composition are currently provided by Ink + Yoga; OpenTUI requires building from scratch. Estimated effort: 2-3 person-days.

## Reusable Assets

This is not a complete rewrite. The following modules are render-layer independent and can be directly reused:

- **Composer state machine** (`composerState.ts`): pure function, input key codes output new state + Effect, zero dependencies
- **ANSI input parser** (`inputKeys.ts`): custom module, directly usable for OpenTUI's stdin event stream
- **UiEvent protocol** (`events.ts`): event definitions and `projectUiEvent` projection function, render-independent
- **Command implementations** (`commands/*.ts`): pure logic for 17 Slash commands, only UI bindings need replacement
- **Session/context management** (`ReplContext`): storage, routing, Provider switching logic fully retained
- **Diff algorithm** (`diff` library integration): word-level diff computation logic unchanged, only render output replaced
- **Renderers** (`renderers/*.ts`): ANSI color parsing, syntax highlighting logic reused; JSX output replaced

Rough estimate: approximately 40-50% of the code (by line count) can be reused directly or with minor adaptation.

## Migration Cost Estimation

### Phased Effort Estimates

| Phase | Content | Estimated Person-Days | Risk Level |
|---|---|---|---|
| PoC-0 | Environment setup, Hello World, verify basic stdin/stdout pipeline | 1-2 | Low |
| PoC-1 | InputBar port (Composer state machine + ANSI parser + rendering) | 2-3 | Low |
| PoC-2 | Basic message list rendering (no virtual scrolling) | 2-3 | Medium |
| PoC-3 | Virtual scrolling + Line Estimation port | 3-5 | High |
| PoC-4 | Slash command system + completion UI | 2-3 | Low |
| PoC-5 | Overlay system + DiffView port | 3-5 | High |
| PoC-6 | StatusBar + animation + theme system | 2-3 | Medium |
| PoC-7 | CJK/IME compatibility validation + fixes | 2-5 | High |
| **PoC Total** | | **17-29** | |
| Alpha | Feature-complete + internal trial | 5-10 | Medium |
| Beta | Performance tuning + bug fixes | 5-10 | Medium |
| GA | Documentation + smooth switchover (feature flag) | 3-5 | Low |
| **Total** | | **30-54 person-days** | |

> Note: estimates above are based on a single developer working full-time. With multiple developers in parallel, total calendar time can be compressed, but communication and merge costs increase.

### Risk Matrix

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| OpenTUI API unstable, frequent breaking changes | High | High -- forced to follow up with fixes | Lock version during PoC, evaluate stability before committing |
| CJK/IME compatibility issues unsolvable | Medium | High -- unusable for Chinese users | Execute PoC-7 early, set go/no-go red line |
| Virtual scrolling performance worse than Ink version | Medium | Medium -- degraded large session experience | PoC-3 stress test with 500+ messages for comparison |
| Component library development effort underestimated | High | Medium -- delays | Source locally (only build necessary abstractions), don't aim for a general component library |
| Thin community ecosystem, no references for problems | High | Medium -- increased troubleshooting time | Be mentally prepared for self-maintenance; fork if necessary |
| Ink version still needs maintenance during migration | Medium | Low -- dual-track burden | Use feature flag for gradual rollout, keep Ink version until 3 months after GA |

## PoC Execution Plan

### PoC-0: Technical Feasibility Study (1-2 days)

Before entering formal PoC, complete the following investigations:

- [ ] Read OpenTUI documentation and API, fully understand its rendering model and component system
- [ ] Run OpenTUI "Hello World" in the Vera project, verify stdin/stdout pipeline and resize events
- [ ] Verify CJK character (Chinese/Japanese/Korean) rendering width in OpenTUI is correct (wide chars = 2 columns)
- [ ] Verify IME input behavior in OpenTUI (whether composing Chinese characters gets split)
- [ ] Output a feasibility memo, clearly answering "can existing functionality be covered" and "which capabilities require trade-offs"

**Go/No-Go condition**: CJK rendering and IME input must pass basic verification, otherwise do not proceed to subsequent phases.

### PoC-1: InputBar First (2-3 days)

Choose InputBar as the first porting target, rationale:

- It is the most user-facing component (every interaction goes through it)
- The underlying Composer state machine and ANSI parser can be directly reused; only the render layer needs replacement
- Can quickly validate OpenTUI's input event model and state-driven rendering pattern

Success criteria: input line behavior fully consistent with the Ink version (cursor, completion, history navigation, external editor).

### PoC-2: Message List + Virtual Scrolling (5-8 days)

This is the most critical and difficult part of the entire migration:

1. First, basic message rendering without virtual scrolling (2-3 days), validate message type mapping
2. Port Line Estimation logic (1-2 days), validate line height estimation accuracy
3. Implement viewport clipping (2-3 days), validate scroll performance and correctness in 500+ message scenarios

Success criteria: in 100-message scenarios, scroll frame rate >= 30fps, no visual flicker.

### PoC-3: Full Functional Equivalence (10-15 days)

Port in order: Slash command UI → Overlay system → DiffView → StatusBar + animations

Success criteria: pass complete functional smoke test checklist (covering all 17 commands, 5 Overlay types, Plan Mode).

## Decision Matrix

| Dimension | Keep Ink (Incremental Evolution) | Switch to OpenTUI |
|---|---|---|
| **Functional completeness** | 100%, verified | Unknown, determined post-PoC |
| **Development investment** | Low (2-5 days per Phase) | High (30-54 days) |
| **Performance improvement** | Moderate (React optimization limited) | Expected high (removing reconciler) |
| **Maintenance burden** | React + Ink major version upgrade risk | Long-term custom component maintenance cost |
| **Team skill match** | React ecosystem, easy to hire | Niche framework, high learning curve |
| **Community support** | Ink 5.x actively maintained | Few community resources, self-exploration needed |
| **Long-term evolution capability** | Limited by React terminal rendering constraints | Full render pipeline control, high customizability |
| **Rollback cost** | None (each increment reversible) | High (nearly irreversible after full migration) |

### Recommendation

**Short-term (0-3 months)**: continue executing the [Ink Incremental Evolution Plan](./tui-ink.md), completing Phase 1-5 App decomposition, Composer modularization, event protocol formalization, viewport abstraction, and performance optimization. These improvements enhance code quality and maintainability regardless of whether the framework is eventually switched.

**Mid-term (3-6 months)**: if the following issues persist after completing Ink evolution Phases 1-4, initiate OpenTUI PoC-0 and PoC-1:

- Ink's React reconciler becomes a performance bottleneck (noticeable lag when message count > 500)
- Ink major version upgrade introduces unremovable breaking changes
- Team has spare capacity for technical feasibility study (at least 0.5 person)

**Conditions to trigger the switch** (must all be met):

1. All PoCs passed, functional equivalence coverage >= 95%
2. OpenTUI API stable for at least 2 minor versions (or team willing to fork and maintain)
3. Performance benchmarks show OpenTUI version significantly outperforms Ink version in 500+ message scenarios (latency reduction >= 30%)
4. CJK/IME compatibility reaches Ink-equivalent level

**Scenarios where migration should NOT happen**:

- Incremental evolution resolved core pain points, performance acceptable
- OpenTUI community inactive, API changing frequently
- CJK/IME compatibility cannot reach usable standard
- Team resources tight, unable to afford 30+ days of migration

## Conclusion

OpenTUI rewrite is a high-investment, high-risk option. In theory, it can resolve Ink's architectural limitations (React overhead, Ref waterfall, virtual DOM diff), but actual benefits require PoC validation. The rational strategy for the current phase is: **first complete Ink incremental evolution, while concurrently conducting OpenTUI technical feasibility study (PoC-0) at minimal cost, then make the final decision with first-hand data.** Before that, do not make any rewrite commitments or architectural assumptions.
