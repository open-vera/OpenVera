# UI Refinement Plan

> Goal: Improve visual consistency, interaction smoothness, accessibility, and responsive experience on top of the existing Harness Web UI skeleton.

## Current Baseline

Gateway Web UI already has basic Run list, Run details, and Memory/Checkpoint/Subagent views. This section focuses on UI quality improvements, not adding new business pages.

## Theme System

### Design Principles

- Based on TDesign design tokens, extended with Vera brand colors and semantic colors
- All colors referenced via CSS variables; hardcoded color values are forbidden
- Supports dark/light dual themes, following system preference or manual toggle

### Token Hierarchy

```
:root {
  /* Brand */
  --vera-brand:             rgb(215, 119, 87);    /* Vera Orange */
  --vera-brand-hover:       rgb(235, 159, 127);   /* Hover highlight */
  --vera-brand-active:      rgb(195, 99, 67);     /* Active press */

  /* Semantic */
  --vera-success:           rgb(78, 186, 101);    /* Success */
  --vera-error:             rgb(255, 107, 128);   /* Error */
  --vera-warning:           rgb(255, 193, 7);     /* Warning */

  /* Text hierarchy */
  --vera-text-primary:      rgba(0, 0, 0, 0.9);
  --vera-text-secondary:    rgba(0, 0, 0, 0.6);
  --vera-text-placeholder:  rgba(0, 0, 0, 0.4);
  --vera-text-disabled:     rgba(0, 0, 0, 0.26);

  /* Backgrounds */
  --vera-bg-base:           rgb(255, 255, 255);
  --vera-bg-container:      rgb(247, 247, 247);
  --vera-bg-elevated:       rgb(255, 255, 255);

  /* Spacing */
  --vera-space-xs: 4px;
  --vera-space-sm: 8px;
  --vera-space-md: 16px;
  --vera-space-lg: 24px;
  --vera-space-xl: 32px;
}
```

### Dark Theme Overrides

```css
[theme-mode="dark"] {
  --vera-text-primary:      rgba(255, 255, 255, 0.9);
  --vera-text-secondary:    rgba(255, 255, 255, 0.6);
  --vera-bg-base:           rgb(26, 26, 26);
  --vera-bg-container:      rgb(34, 34, 34);
  --vera-bg-elevated:       rgb(42, 42, 42);
}
```

## Component Refinement

### Run Card Improvements

- Status indicator uses pulse animation (running state)
- Add relative time display ("3 minutes ago", "1 hour ago" instead of absolute timestamps)
- Tool call count and token consumption directly visible on the card
- Long title truncation + tooltip on hover for full display

### Timeline Component

- Phase transition animation: current phase highlighted + completed phases dimmed, 200ms ease transition
- Step collapse/expand: last N steps expanded by default, rest collapsed
- Tool call inline preview: single-line truncation, click to expand full JSON
- Virtual scrolling: enabled when Run exceeds 100 steps, maintaining render performance

### Status Panel

- Empty state illustration + guide text (no Run / no Checkpoint / no Memory)
- Loading skeleton screen: ListItem placeholder shape + shimmer animation
- Error state: friendly error message + retry button
- Scroll position memory: restore scroll position when returning after tab switch

### Input Component

- Multi-line input, Shift+Enter for newline
- Slash command panel: type `/` to trigger dropdown menu (/flow, /model, /provider)
- History: ArrowUp/ArrowDown to browse sent messages
- Character count: display current/length limit at bottom-right of input

## Interaction Improvements

### Keyboard Navigation

- `Ctrl+K` / `Cmd+K` opens command palette (global search, page navigation)
- `Ctrl+[` / `Ctrl+]` toggle sidebar
- `Esc` close modal / dropdown / command palette
- `j` / `k` navigate up/down in lists
- `Enter` confirm selection
- `?` show keyboard shortcut list

### Responsive Layout

| Breakpoint | Width | Layout |
|---|---|---|
| Mobile | < 768px | Single column, sidebar as drawer, tables to cards |
| Tablet | 768px - 1024px | Two columns, sidebar collapsible |
| Desktop | > 1024px | Three columns (nav + content + detail panel) |

When resizing a running window, auto-collapse secondary panels, prioritizing timeline and content visibility.

### Transitions & Feedback

- Page transitions: route transition 200ms fade
- List updates: new entries fade in (opacity 0 → 1)
- Delete operations: slide-out animation + toast confirmation
- Long operations (Run launch, RAG index rebuild): loading overlay + progress indicator
- Copy button: one-click copy at top-right of tool call args / code blocks; button shows ✓ for 1 second after copying

## Accessibility

- All interactive elements support `Tab` focus, visible focus ring (`:focus-visible` outline 2px brand color)
- Icons paired with `aria-label` for screen reader text
- Tables use `<thead>` / `<tbody>` + `scope` attributes
- Status colors not relying on a single color expression (running state uses icon + text + color simultaneously)
- Touch targets no smaller than 44x44px (mobile touch-friendly)

## Performance Budget

- First screen load (LCP) < 2.5 seconds
- Interaction response (INP) < 200ms
- Run list virtual scrolling threshold: enabled above 100 entries
- API data request batching: list page fetches 30 entries per request, scroll to load more
- Images/icons use SVG sprite or icon font to reduce request count

## Implementation Priority

1. **P0**: Theme system + empty/loading/error states
2. **P1**: Keyboard navigation + responsive layout
3. **P2**: Animation transitions + virtual scrolling
4. **P3**: Accessibility audit + dark theme refinements
