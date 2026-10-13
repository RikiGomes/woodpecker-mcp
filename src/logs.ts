import type { LogEntry } from "./client.ts";

export interface RenderedLogs {
  text: string;
  total: number;
  shown: number;
}

// CSI and OSC escape sequences (colours, cursor moves, hyperlinks).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Decodes one log entry's base64 `data` field into UTF-8 text, without the
 * trailing newline, terminal escape codes, or spinner frames overwritten by
 * a carriage return (only the last non-empty frame was visible).
 */
export function decodeLogEntry(entry: LogEntry): string {
  if (!entry.data) return "";
  const text = Buffer.from(entry.data, "base64").toString("utf8").replace(/\r?\n$/, "").replace(ANSI, "");
  if (!text.includes("\r")) return text;
  const frames = text.split("\r");
  return frames.findLast((frame) => frame !== "") ?? "";
}

/**
 * Renders a step's log entries as plain text, keeping only the last `tail`
 * lines. Woodpecker returns the whole stored log in one response, which for a
 * chatty build can be tens of thousands of lines; tailing protects the
 * caller's context window; a non-positive `tail` disables tailing and returns
 * every line. Lines longer than 2000 chars are clipped, and `maxChars` drops
 * the oldest shown lines until the text fits. Exit-code entries (type 2) are
 * labelled so the final status is visible even in a tailed view. Runs of
 * identical lines collapse into one line marked `[repeated N times]` before
 * tailing. Entries without a line number keep their original position
 * instead of being sorted to the front.
 *
 * The logs endpoint returns HTTP 200 with body `null` for a step that
 * produced no output (skipped, or failed before emitting), so a non-array
 * body is normalised to an empty log rather than throwing.
 */
export function renderStepLogs(
  entries: LogEntry[] | null | undefined,
  tail: number,
  maxChars = Number.POSITIVE_INFINITY,
): RenderedLogs {
  const lines = collapseRepeats(logLines(entries).map((line) => clip(line, MAX_TAIL_LINE_CHARS)));
  const shown = tail > 0 ? lines.slice(-tail) : lines;
  // Keep the newest lines when the tail is still too large for the caller's context.
  let size = shown.reduce((sum, line) => sum + line.length + 1, 0);
  while (shown.length > 1 && size > maxChars) size -= shown.shift()!.length + 1;
  return { text: shown.join("\n"), total: lines.length, shown: shown.length };
}

const MAX_TAIL_LINE_CHARS = 2000;

function clip(line: string, max: number): string {
  if (line.length <= max) return line;
  // Don't split a surrogate pair (emoji and other astral characters).
  const cut = /[\uD800-\uDBFF]/.test(line[max - 1] ?? "") ? max - 1 : max;
  return `${line.slice(0, cut)}... [${line.length - cut} chars clipped]`;
}

function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(j - i > 1 ? `${lines[i]} [repeated ${j - i} times]` : (lines[i] ?? ""));
    i = j;
  }
  return out;
}

/** One decoded line per log entry, in line order; progress entries (type 4) are dropped. */
function logLines(entries: LogEntry[] | null | undefined): string[] {
  const ordered = [...(Array.isArray(entries) ? entries : [])].filter((entry) => entry.type !== 4).sort((a, b) =>
    a.line === undefined || b.line === undefined ? 0 : a.line - b.line,
  );
  return ordered.map((entry) => {
    const text = decodeLogEntry(entry);
    return entry.type === 2 ? `[exit code] ${text}` : text;
  });
}

const MAX_MATCH_LINE_CHARS = 500;

export interface LogMatches {
  text: string;
  total: number;
  matches: number;
  truncated: boolean;
}

/**
 * grep -C over a step's log: lines containing any of `terms` (case-insensitive
 * plain text, so no regex can stall the server), numbered, with `context`
 * lines either side and `--` between non-adjacent groups. Stops at
 * `maxMatches` hits or `maxChars` of output, whichever comes first.
 */
export function searchStepLogs(
  entries: LogEntry[] | null | undefined,
  terms: string[],
  context: number,
  maxMatches: number,
  maxChars = Number.POSITIVE_INFINITY,
): LogMatches {
  const lines = logLines(entries);
  const needles = terms.map((term) => term.toLowerCase());

  const hits: number[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").toLowerCase();
    if (needles.some((needle) => line.includes(needle))) {
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
  let size = 0;
  let previous = -1;
  for (const i of [...shown].sort((a, b) => a - b)) {
    const row = `${out.length && i > previous + 1 ? "--\n" : ""}${i + 1}${hitSet.has(i) ? ":" : "-"} ${clip(lines[i] ?? "", MAX_MATCH_LINE_CHARS)}`;
    if (out.length && size + row.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    out.push(row);
    size += row.length + 1;
    previous = i;
  }
  return { text: out.join("\n"), total: lines.length, matches: hits.length, truncated };
}
