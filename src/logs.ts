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
