import { Box, Text } from "ink";
import { useMemo } from "react";
import figlet from "figlet";
import type { RoutingInfo } from "./types.js";
import { InputBar } from "./InputBar.js";
import type { ExternalEditorResult } from "./state/externalEditor.js";
import { theme } from "./theme.js";

// Generated once at module load — figlet handles all alignment automatically
const MASCOT = figlet.textSync("VERA", { font: "ANSI Shadow" }).split("\n").filter(l => l.trim());

const TIPS = [
  "ESC to cancel a running request",
  "Ctrl+C clears the input, or exits if empty",
  "/status shows provider, model & token usage",
  "/help lists all available commands",
  "Interrupt mid-stream — your input is queued",
  "Routing picks the right model for each query",
  "Tool results over 50 KB are saved to disk",
  "Context window is managed automatically",
  "Paste multi-line text — it lands on one line",
];

// Aurora gradient: magenta → purple → indigo → cyan → teal
const GRADIENTS = [
  // Aurora
  [{ r: 255, g:  80, b: 200 }, { r: 180, g:  80, b: 255 }, { r:  80, g: 130, b: 255 }, { r:   0, g: 210, b: 255 }],
  // Sunset
  [{ r: 255, g:  80, b:  60 }, { r: 255, g: 130, b:  60 }, { r: 220, g:  60, b: 160 }, { r: 140, g:  60, b: 255 }],
  // Ocean
  [{ r:   0, g: 230, b: 200 }, { r:   0, g: 180, b: 255 }, { r:  60, g:  80, b: 255 }, { r: 140, g:  40, b: 200 }],
  // Matrix
  [{ r:   0, g: 255, b: 120 }, { r:   0, g: 210, b: 180 }, { r:   0, g: 160, b: 255 }, { r:  80, g:  80, b: 255 }],
  // Fire
  [{ r: 255, g: 200, b:  30 }, { r: 255, g: 120, b:  20 }, { r: 220, g:  40, b:  40 }, { r: 160, g:  20, b: 100 }],
  // Cosmic
  [{ r: 200, g:  20, b: 255 }, { r: 100, g:  20, b: 255 }, { r:  20, g: 100, b: 255 }, { r:   0, g: 220, b: 220 }],
];

// Pick once per process start
const SESSION_GRADIENT = GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)]!;

type RGB = { r: number; g: number; b: number };

function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function gradientColor(t: number): string {
  // t in [0, 1] — interpolates across SESSION_GRADIENT stops
  const scaled = t * (SESSION_GRADIENT.length - 1);
  const lo = Math.floor(scaled);
  const hi = Math.min(lo + 1, SESSION_GRADIENT.length - 1);
  const frac = scaled - lo;
  const c = lerpColor(SESSION_GRADIENT[lo] as RGB, SESSION_GRADIENT[hi] as RGB, frac);
  return `rgb(${c.r},${c.g},${c.b})`;
}

interface WelcomeScreenProps {
  cwd: string;
  routing: RoutingInfo;
  columns: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (line: string) => void;
  onExit: () => void;
  showInput?: boolean;
  pathCandidates?: string[];
  onOpenExternalEditor?: (request: { initialValue: string; cursor: number }) => void | Promise<ExternalEditorResult | null>;
}

export function WelcomeScreen({
  cwd,
  routing,
  columns,
  value,
  onChange,
  onSubmit,
  onExit,
  showInput = true,
  pathCandidates,
  onOpenExternalEditor,
}: WelcomeScreenProps) {
  const workingDir = "~" + cwd.replace(process.env.HOME ?? "", "");
  const tip = useMemo(() => TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0], []);

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="row"
        width={columns}
        marginTop={1}
        marginBottom={1}
      >
        {/* Left — ASCII art, flex-grows to fill remaining space */}
        <Box
          flexDirection="column"
          flexGrow={1}
          alignItems="flex-start"
          justifyContent="center"
          paddingX={2}
          paddingY={1}
        >
          {MASCOT.map((line, i) => (
            <Text key={i} color={gradientColor(i / (MASCOT.length - 1))} bold>
              {line}
            </Text>
          ))}
        </Box>

        {/* Right — provider info + random tip, with border */}
        <Box
          flexDirection="column"
          paddingX={3}
          paddingY={1}
          justifyContent="center"
          borderStyle="round"
          borderColor={gradientColor(0.5)}
          marginRight={1}
        >
          <Text color={theme.textDim}>{routing.provider}</Text>
          <Text color={gradientColor(0.3)}>{routing.model}</Text>
          <Text color={theme.suggestion}>{workingDir}</Text>
          <Text> </Text>
          <Text color={theme.textDim} dimColor>💡 {tip}</Text>
        </Box>
      </Box>

      <Box>
        <Text color={theme.textSubtle}>{"─".repeat(columns)}</Text>
      </Box>

      {showInput && (
        <InputBar
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onExit={onExit}
          pathCandidates={pathCandidates}
          onOpenExternalEditor={onOpenExternalEditor}
        />
      )}
    </Box>
  );
}
