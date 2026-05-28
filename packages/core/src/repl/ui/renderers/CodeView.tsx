import { Box, Text } from "ink";

const MAX_LINES = 10;

// Keywords to highlight per language family
const TS_KEYWORDS = new Set([
  "import", "export", "from", "default", "const", "let", "var",
  "function", "class", "interface", "type", "enum", "extends", "implements",
  "return", "if", "else", "for", "while", "switch", "case", "break",
  "async", "await", "new", "this", "typeof", "instanceof", "void",
  "null", "undefined", "true", "false",
]);

interface CodeViewProps {
  content: string;
  lang?: string;
  width: number;
  expanded?: boolean;
}

export function CodeView({ content, width, expanded }: CodeViewProps) {
  const lines = content.split("\n");
  const truncated = !expanded && lines.length > MAX_LINES;
  const visible = truncated ? lines.slice(0, MAX_LINES) : lines;
  const remaining = lines.length - MAX_LINES;

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((line, i) => (
        <CodeLine key={i} line={line} />
      ))}
      {truncated && (
        <Text color="gray">[... +{remaining} lines (⌥O to expand)]</Text>
      )}
    </Box>
  );
}

function CodeLine({ line }: { line: string }) {
  // Line number prefix (e.g. "   1\t") — render number in dim, rest as code
  const tabIdx = line.indexOf("\t");
  if (tabIdx !== -1) {
    const lineNum = line.slice(0, tabIdx);
    const code = line.slice(tabIdx + 1);
    const num = parseInt(lineNum.trim(), 10);
    if (!isNaN(num)) {
      return (
        <Box>
          <Text color="gray">{lineNum.padStart(4)}</Text>
          <Text color="gray">{"│"}</Text>
          <Text> </Text>
          <HighlightedCode code={code} />
        </Box>
      );
    }
  }
  return <HighlightedCode code={line} />;
}

function HighlightedCode({ code }: { code: string }) {
  // Simple keyword highlight: split on word boundaries, color keywords cyan
  const tokens = tokenize(code);
  return (
    <Box>
      {tokens.map((tok, i) =>
        tok.isKeyword ? (
          <Text key={i} color="cyan">{tok.text}</Text>
        ) : tok.isString ? (
          <Text key={i} color="green">{tok.text}</Text>
        ) : tok.isComment ? (
          <Text key={i} color="gray">{tok.text}</Text>
        ) : (
          <Text key={i}>{tok.text}</Text>
        )
      )}
    </Box>
  );
}

interface Token { text: string; isKeyword: boolean; isString: boolean; isComment: boolean }

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  // Line comment
  if (code.trimStart().startsWith("//") || code.trimStart().startsWith("#")) {
    return [{ text: code, isKeyword: false, isString: false, isComment: true }];
  }

  while (i < code.length) {
    // String literals
    if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const quote = code[i]!;
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === "\\") j++;
        j++;
      }
      tokens.push({ text: code.slice(i, j + 1), isKeyword: false, isString: true, isComment: false });
      i = j + 1;
      continue;
    }

    // Word token
    if (/[A-Za-z_$]/.test(code[i]!)) {
      let j = i;
      while (j < code.length && /[\w$]/.test(code[j]!)) j++;
      const word = code.slice(i, j);
      tokens.push({ text: word, isKeyword: TS_KEYWORDS.has(word), isString: false, isComment: false });
      i = j;
      continue;
    }

    // Everything else — accumulate non-word chars
    let j = i;
    while (j < code.length && !/[A-Za-z_$"'`]/.test(code[j]!)) j++;
    tokens.push({ text: code.slice(i, j), isKeyword: false, isString: false, isComment: false });
    i = j;
  }

  return tokens;
}
