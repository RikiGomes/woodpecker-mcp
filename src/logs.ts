import type { LogEntry } from "./client.ts";

export interface RenderedLogs {
  text: string;
  total: number;
  shown: number;
}

/** Decodes one log entry's base64 `data` field into UTF-8 text, without trailing newline. */
export function decodeLogEntry(entry: LogEntry): string {
  if (!entry.data) return "";
  return Buffer.from(entry.data, "base64").toString("utf8").replace(/\r?\n$/, "");
}

/**
 * Renders a step's log entries as plain text, keeping only the last `tail`
 * lines. Woodpecker returns the whole stored log in one response, which for a
 * chatty build can be tens of thousands of lines — tailing protects the
 * caller's context window; a non-positive `tail` disables tailing and returns
 * every line. Exit-code entries (type 2) are labelled so the final status is
 * visible even in a tailed view. Entries without a line number keep their
 * original position instead of being sorted to the front.
 *
 * The logs endpoint returns HTTP 200 with body `null` for a step that
 * produced no output (skipped, or failed before emitting), so a non-array
 * body is normalised to an empty log rather than throwing.
 */
export function renderStepLogs(entries: LogEntry[] | null | undefined, tail: number): RenderedLogs {
  const ordered = [...(Array.isArray(entries) ? entries : [])].sort((a, b) =>
    a.line === undefined || b.line === undefined ? 0 : a.line - b.line,
  );
  const lines = ordered.map((entry) => {
    const text = decodeLogEntry(entry);
    return entry.type === 2 ? `[exit code] ${text}` : text;
  });
  const shown = tail > 0 ? lines.slice(-tail) : lines;
  return { text: shown.join("\n"), total: lines.length, shown: shown.length };
}

export interface LogMatches {
  text: string;
  total: number;
  matches: number;
  truncated: boolean;
}

/**
 * Greps a step's log for `pattern`, returning each match with `context` lines
 * either side (grep -C style, overlapping windows merged, groups separated by
 * `--`). Lines are prefixed with their 1-based line number so the caller can
 * ask for more context around a specific spot. Stops after `maxMatches`.
 */
export function searchStepLogs(
  entries: LogEntry[] | null | undefined,
  pattern: RegExp,
  context: number,
  maxMatches: number,
): LogMatches {
  const lines = renderStepLogs(entries, 0).text.split("\n");
  if (lines.length === 1 && lines[0] === "") return { text: "", total: 0, matches: 0, truncated: false };

  const hits: number[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? "")) {
      if (hits.length === maxMatches) {
        truncated = true;
        break;
      }
      hits.push(i);
    }
  }

  const hitSet = new Set(hits);
  const shown = new Set<number>();
  for (const hit of hits) {
    for (let i = Math.max(0, hit - context); i <= Math.min(lines.length - 1, hit + context); i++) shown.add(i);
  }
  const out: string[] = [];
  let previous = -1;
  for (const i of [...shown].sort((a, b) => a - b)) {
    if (out.length && i > previous + 1) out.push("--");
    out.push(`${i + 1}${hitSet.has(i) ? ":" : "-"} ${lines[i]}`);
    previous = i;
  }
  return { text: out.join("\n"), total: lines.length, matches: hits.length, truncated };
}
