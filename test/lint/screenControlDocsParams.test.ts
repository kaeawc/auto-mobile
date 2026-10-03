import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { createFakeDaemonState } from "../daemon/helpers/inputSocketHarness";
import { FakeTimer } from "../fakes/FakeTimer";

const doc = readFileSync(
  join(import.meta.dir, "../../docs/using/screen-control.md"),
  "utf8",
).replace(/\r\n?/g, "\n");
const server = new UnixSocketServer(
  "/fake/screen-control-docs.sock",
  "http://localhost:0/mcp",
  createFakeDaemonState(),
  new FakeTimer(),
);

// These are the parser-backed input routes in handleLocalSocketRequest. No listener is started.
const parsers = new Map<string, (params: unknown) => unknown>([
  ["input/tap", (params) => server["parseInputTapParams"](params)],
  ["input/swipe", (params) => server["parseInputSwipeParams"](params)],
  ["input/typeText", (params) => server["parseInputTypeTextParams"](params)],
  ["input/pressButton", (params) => server["parseInputPressButtonParams"](params)],
  ["input/key", (params) => server["parseInputKeyParams"](params)],
  ...["input/gestureStart", "input/gestureMove", "input/gestureEnd"].map(
    (method): [string, (params: unknown) => unknown] => [
      method,
      (params) => server["parseInputGestureParams"](params, method),
    ],
  ),
]);

interface FencedBlock {
  info: string;
  content: string;
}

// No installed direct Markdown parser or existing fenced-block helper: track fences,
// never JSON structure. A shorter fence inside a longer one is content, not a close.
function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { length: number; info: string; lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    const fence = /^ {0,3}(`{3,})(.*)$/.exec(line);
    if (!open) {
      if (fence && !fence[2].includes("`")) {
        open = { length: fence[1].length, info: fence[2].trim(), lines: [] };
      }
      continue;
    }
    if (fence && fence[1].length >= open.length && fence[2].trim() === "") {
      blocks.push({ info: open.info, content: open.lines.join("\n") });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  if (open) {
    throw new Error(`Unclosed ${open.info} code fence`);
  }
  return blocks;
}

function jsonObjects(content: string): unknown[] {
  try {
    return [JSON.parse(content)];
  } catch (error) {
    // A fence may contain NDJSON instead of a single formatted JSON object.
    // Malformed JSON still propagates from the per-line JSON.parse below.
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function parserFor(method: unknown): (params: unknown) => unknown {
  if (typeof method !== "string") {
    throw new Error("Input method must be a string");
  }
  const parser = parsers.get(method);
  if (!parser) {
    throw new Error(`Undocumented input route: ${method}`);
  }
  return parser;
}

function validateRequests(markdown: string): number {
  let requests = 0;
  for (const block of fencedBlocks(markdown).filter((block) => block.info === "json")) {
    for (const value of jsonObjects(block.content)) {
      const request = record(value);
      if (request.type !== "daemon_request") {
        continue;
      }
      expect(typeof request.id).toBe("string");
      expect(request.id).not.toBe("");
      expect(typeof request.method).toBe("string");
      parserFor(request.method)(request.params);
      requests++;
    }
  }
  return requests;
}

function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const char of line.trim()) {
    if (char === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
    escaped = char === "\\" && !escaped;
  }
  cells.push(cell.trim());
  return cells.slice(1, -1);
}

function codeTokens(cell: string): string[] {
  return Array.from(cell.matchAll(/`([^`]+)`/g), (match) => match[1]);
}

function commandRows(markdown: string): string[][] {
  const section = markdown.split("## Input commands\n")[1]?.split("## Client examples")[0];
  if (!section) {
    throw new Error("Missing Input commands section");
  }
  return section
    .split("\n")
    .filter((line) => line.trim().startsWith("| `input/"))
    .map(tableCells);
}

const samples: Record<string, unknown> = {
  platform: "android",
  deviceId: "emulator-5554",
  x: 540,
  y: 960,
  duration: 100,
  startX: 540,
  startY: 1600,
  endX: 540,
  endY: 400,
  durationMs: 300,
  button: "home",
  key: "enter",
  text: "hello",
  mode: "append",
  submit: false,
  frameContext: "frame-1",
  gestureId: "drag-1",
  cancel: false,
};

function sampleParams(names: string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.map((name) => {
      const param = name.endsWith("?") ? name.slice(0, -1) : name;
      if (!Object.hasOwn(samples, param)) {
        throw new Error(`No canonical sample for documented param: ${param}`);
      }
      return [param, samples[param]];
    }),
  );
}

function validateTableRow(methodCell: string, paramsCell: string): void {
  const names = codeTokens(paramsCell.split("(e.g.")[0].split(" — ")[0]);
  const params = sampleParams(names);
  for (const method of codeTokens(methodCell)) {
    const parser = parserFor(method);
    expect(() => parser(params), `${method}: documented params`).not.toThrow();
    for (const name of names) {
      const param = name.endsWith("?") ? name.slice(0, -1) : name;
      const without = { ...params };
      delete without[param];
      if (name.endsWith("?")) {
        expect(() => parser(without), `${method}: optional ${param}`).not.toThrow();
      } else {
        expect(() => parser(without), `${method}: required ${param}`).toThrow();
      }
      // Restoring each documented key to an otherwise valid sample must be accepted.
      expect(
        () => parser({ ...without, [param]: samples[param] }),
        `${method}: ${param}`,
      ).not.toThrow();
    }
    const examples = paramsCell.split("(e.g.")[1]?.split(")")[0];
    if (examples) {
      const param = method === "input/pressButton" ? "button" : "key";
      for (const value of codeTokens(examples)) {
        expect(
          () => parser({ ...params, [param]: value }),
          `${method}: example ${value}`,
        ).not.toThrow();
      }
    }
  }
}

describe("screen control docs match real socket parsers", () => {
  test("every JSON/NDJSON request validates", () => {
    expect(validateRequests(doc)).toBe(4);
  });

  test("table methods, required/optional params, and button/key examples validate", () => {
    const rows = commandRows(doc);
    expect(rows.flatMap(([method]) => codeTokens(method)).sort()).toEqual(
      [...parsers.keys()].sort(),
    );
    for (const [method, params] of rows) {
      validateTableRow(method, params);
    }
  });

  test("rejects the original append regression through the extractor and validator", () => {
    const badDoc =
      '```json\n{"id":"bad","type":"daemon_request","method":"input/typeText","params":{"platform":"android","text":"x","append":true}}\n```';
    expect(() => validateRequests(badDoc)).toThrow("input/typeText unsupported params: append");
  });

  test("extracts longer fences, exact info strings, multiline JSON, and NDJSON", () => {
    const markdown = [
      "````text",
      "```json",
      "ignored",
      "```",
      "````",
      "```json",
      "{",
      '"id":"one","type":"daemon_request","method":"input/tap",',
      '"params":{"platform":"android","x":1,"y":2}',
      "}",
      "```",
      "```json",
      '{"id":"two","type":"daemon_request","method":"input/key","params":{"platform":"android","key":"tab"}}',
      "",
      '{"id":"three","type":"daemon_request","method":"input/key","params":{"platform":"android","key":"enter"}}',
      "```",
      "```json extra",
      "ignored",
      "```",
    ].join("\n");
    expect(fencedBlocks(markdown)[0]).toEqual({ info: "text", content: "```json\nignored\n```" });
    expect(validateRequests(markdown)).toBe(3);
    expect(() => fencedBlocks("```json\n{}")).toThrow("Unclosed json code fence");
    expect(() => jsonObjects('{"broken":}')).toThrow();
    expect(tableCells("| `input/tap` | escaped \\| pipe |")).toEqual([
      "`input/tap`",
      "escaped \\| pipe",
    ]);
  });

  test("table guard rejects unknown params, incorrect requiredness, and unsupported examples", () => {
    expect(() => validateTableRow("`input/typeText`", "`platform`, `text`, `mystery?`")).toThrow(
      "No canonical sample for documented param: mystery",
    );
    expect(() => validateTableRow("`input/typeText`", "`platform`, `text`, `submit`")).toThrow();
    expect(() => validateTableRow("`input/key`", "`platform`, `key` (e.g. `invalid`)")).toThrow();
    expect(() => parserFor("input/nonexistent")).toThrow("Undocumented input route");
  });
});
