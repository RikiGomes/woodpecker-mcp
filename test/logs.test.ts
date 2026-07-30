import { describe, expect, it } from "vitest";
import type { LogEntry } from "../src/client.ts";
import { decodeLogEntry, renderStepLogs } from "../src/logs.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("decodeLogEntry", () => {
  it("decodes base64 data and strips the trailing newline", () => {
    expect(decodeLogEntry({ data: b64("hello world\n") })).toBe("hello world");
  });

  it("keeps lines without trailing newline intact", () => {
    expect(decodeLogEntry({ data: b64("no newline") })).toBe("no newline");
  });

  it("returns empty string for missing data", () => {
    expect(decodeLogEntry({ data: null })).toBe("");
    expect(decodeLogEntry({})).toBe("");
  });
});

describe("renderStepLogs", () => {
  const entries = [
    { line: 1, data: b64("step 1\n"), type: 0 },
    { line: 2, data: b64("warning: something\n"), type: 1 },
    { line: 3, data: b64("step 3\n"), type: 0 },
    { line: 4, data: b64("1\n"), type: 2 },
  ];

  it("renders all lines in order and labels exit codes", () => {
    const rendered = renderStepLogs(entries, 100);
    expect(rendered.total).toBe(4);
    expect(rendered.shown).toBe(4);
    expect(rendered.text).toBe("step 1\nwarning: something\nstep 3\n[exit code] 1");
  });

  it("tails to the requested number of lines", () => {
    const rendered = renderStepLogs(entries, 2);
    expect(rendered.total).toBe(4);
    expect(rendered.shown).toBe(2);
    expect(rendered.text).toBe("step 3\n[exit code] 1");
  });

  it("sorts entries by line number before rendering", () => {
    const shuffled = [entries[2]!, entries[0]!, entries[3]!, entries[1]!];
    expect(renderStepLogs(shuffled, 100).text).toBe(renderStepLogs(entries, 100).text);
  });

  it("keeps entries without a line number in their original position", () => {
    const withGap = [
      { line: 1, data: b64("first\n"), type: 0 },
      { data: b64("no line number\n"), type: 0 },
      { line: 2, data: b64("last\n"), type: 0 },
    ];
    expect(renderStepLogs(withGap, 100).text).toBe("first\nno line number\nlast");
  });

  it("returns all lines when tail is not positive", () => {
    const rendered = renderStepLogs(entries, 0);
    expect(rendered.shown).toBe(4);
    expect(rendered.total).toBe(4);
  });

  it("treats a null/undefined body as an empty log", () => {
    // The Woodpecker logs endpoint returns HTTP 200 with body `null` for a
    // step that produced no output (skipped, or failed before emitting).
    for (const empty of [null, undefined] as unknown as LogEntry[][]) {
      const rendered = renderStepLogs(empty, 100);
      expect(rendered).toEqual({ text: "", total: 0, shown: 0 });
    }
  });
});
