import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PressButton } from "../../src/features/action/PressButton";
import { resolveAndroidKeyCode } from "../../src/features/action/pressButtonPolicy";
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
      const method = String(request.method);
      const params = record(request.params);
      const row = commandRows(doc).find(([cell]) => codeTokens(cell).includes(method));
      if (!row) {
        throw new Error(`Undocumented input route: ${method}`);
      }
      const parsed = record(parserFor(method)(params));
      validateParsedParams(method, params, paramNames(row[1]), parsed);
      if (method === "input/key") {
        expect(params.platform, "input/key is Android-only").toBe("android");
      }
      if (method === "input/pressButton") {
        expect(
          buttonSupported(String(params.platform), String(parsed.button)),
          `button ${String(params.button)}: ${String(params.platform)} support`,
        ).toBe(true);
      }
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
  durationMs: 450,
  button: "app_switch",
  key: "enter",
  text: "hello",
  mode: "append",
  submit: true,
  frameContext: "frame-1",
  gestureId: "drag-1",
  cancel: true,
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

// Every wire parameter needs an explicit retention mapping. Only mode/button normalize.
const paramMappings: Record<string, { key: string; expected?: (value: unknown) => unknown }> = {
  platform: { key: "platform" },
  deviceId: { key: "deviceId" },
  x: { key: "x" },
  y: { key: "y" },
  duration: { key: "duration" },
  startX: { key: "startX" },
  startY: { key: "startY" },
  endX: { key: "endX" },
  endY: { key: "endY" },
  durationMs: { key: "durationMs" },
  button: { key: "button", expected: (value) => (value === "app_switch" ? "recent" : value) },
  key: { key: "key" },
  text: { key: "text" },
  mode: { key: "append", expected: (value) => value === "append" },
  submit: { key: "submit" },
  frameContext: { key: "frameContext" },
  gestureId: { key: "gestureId" },
  cancel: { key: "cancel" },
};

function paramNames(cell: string): string[] {
  return codeTokens(cell.split("(e.g.")[0].split(" — ")[0]);
}

function validateParsedParams(
  method: string,
  params: Record<string, unknown>,
  documentedNames: string[],
  result: unknown,
): void {
  const parsed = record(result);
  const names = documentedNames.map((name) => name.replace(/\?$/, ""));
  const parsedKeys = names.map((name) => {
    const mapping = paramMappings[name];
    if (!mapping) {
      throw new Error(`${method}: no retention mapping for documented param ${name}`);
    }
    return mapping.key;
  });
  for (const [param, value] of Object.entries(params)) {
    const mapping = paramMappings[param];
    if (!mapping) {
      throw new Error(`${method}: no retention mapping for documented param ${param}`);
    }
    expect(Object.hasOwn(parsed, mapping.key), `${method}: param ${param} not retained`).toBe(true);
    expect(
      parsed[mapping.key],
      `${method}: param ${param} mapped incorrectly to ${mapping.key}`,
    ).toEqual(mapping.expected ? mapping.expected(value) : value);
    expect(names, `${method}: undocumented param ${param}`).toContain(param);
  }
  // responseButton preserves the original alias in the response; button is normalized for dispatch.
  const allowedKeys = method === "input/pressButton" ? ["responseButton"] : [];
  if (method === "input/pressButton") {
    expect(parsed.responseButton, `${method}: button original value not retained`).toBe(
      params.button,
    );
  }
  for (const key of Object.keys(parsed)) {
    expect([...parsedKeys, ...allowedKeys], `${method}: undocumented parsed key ${key}`).toContain(
      key,
    );
  }
}

function validateTableRow(methodCell: string, paramsCell: string): void {
  const names = paramNames(paramsCell);
  const params = sampleParams(names);
  for (const method of codeTokens(methodCell)) {
    const parser = parserFor(method);
    if (method === "input/key") {
      expect(paramsCell, "input/key must document Android-only support").toContain("Android only");
    }
    validateParsedParams(method, params, names, parser(params));
    for (const name of names) {
      const param = name.replace(/\?$/, "");
      const without = { ...params };
      delete without[param];
      if (name.endsWith("?")) {
        expect(() => parser(without), `${method}: optional ${param}`).not.toThrow();
      } else {
        expect(() => parser(without), `${method}: required ${param}`).toThrow();
      }
    }
    const examples = paramsCell.split("(e.g.")[1]?.split(")")[0];
    if (examples) {
      const param = method === "input/pressButton" ? "button" : "key";
      for (const value of codeTokens(examples)) {
        const example = { ...params, [param]: value };
        validateParsedParams(method, example, names, parser(example));
        if (param === "key") {
          expect(example.platform, "input/key examples must be Android-only").toBe("android");
        }
      }
    }
  }
}

function buttonSupported(platform: string, normalized: string): boolean {
  return platform === "android"
    ? resolveAndroidKeyCode(normalized) !== undefined
    : PressButton.IOS_NAVIGATION_BUTTONS.has(normalized) ||
        PressButton.IOS_HARDWARE_BUTTONS.has(normalized);
}

function validateButtonTable(markdown: string): void {
  const section = markdown.split("### Button support\n")[1]?.trimStart().split("\n\n")[0];
  if (!section) {
    throw new Error("Missing Button support table");
  }
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map(tableCells);
  const documentedButtons = rows.map(([cell]) => codeTokens(cell)[0]);
  const buttonCell = commandRows(markdown).find(
    ([method]) => method === "`input/pressButton`",
  )?.[1];
  const examples = codeTokens(buttonCell?.split("(e.g.")[1]?.split(")")[0] ?? "");
  expect(documentedButtons.sort(), "Every button example needs platform support").toEqual(
    examples.sort(),
  );
  for (const [cell, android, ios] of rows) {
    const button = codeTokens(cell)[0];
    for (const [platform, support] of [
      ["android", android],
      ["ios", ios],
    ]) {
      const params = { platform, button };
      const parsed = record(parserFor("input/pressButton")(params));
      validateParsedParams("input/pressButton", params, paramNames(buttonCell ?? ""), parsed);
      const normalized = String(parsed.button);
      const supported = buttonSupported(platform, normalized);
      expect(support, `button ${button}: ${platform} support`).toBe(supported ? "Yes" : "No");
    }
  }
}

function validateDurationDocs(markdown: string): void {
  expect(markdown, "tap duration must document integer milliseconds").toContain(
    "`duration` for taps is an optional integer number of milliseconds",
  );
  expect(markdown, "swipe durationMs must document integer milliseconds and bounds").toContain(
    "`durationMs` for swipes is an optional integer between 1 and 60000 milliseconds",
  );
  expect(markdown).toContain("defaults to 300 milliseconds");
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
    expect(() =>
      validateTableRow(
        "`input/typeText`",
        "`platform`, `deviceId?`, `text`, `mode?`, `submit`, `frameContext?`",
      ),
    ).toThrow();
    expect(() =>
      validateTableRow(
        "`input/key`",
        "`platform`, `deviceId?`, `key`, `frameContext?` (e.g. `invalid`) — Android only",
      ),
    ).toThrow();
    expect(() => parserFor("input/nonexistent")).toThrow("Undocumented input route");
  });
});

describe("screen control contract guard regressions", () => {
  test("platform button table matches dispatch support, including app_switch normalization", () => {
    validateButtonTable(doc);
  });

  test("rejects menu documented as supported on iOS", () => {
    const badDoc =
      "## Input commands\n" +
      "| `input/pressButton` | `platform`, `deviceId?`, `button`, `frameContext?` (e.g. `menu`) |\n" +
      "### Button support\n\n| Button | Android | iOS |\n| --- | --- | --- |\n| `menu` | Yes | Yes |";
    expect(() => validateButtonTable(badDoc)).toThrow("button menu: ios support");
    const request = {
      id: "menu",
      type: "daemon_request",
      method: "input/pressButton",
      params: { platform: "ios", button: "menu" },
    };
    expect(() => validateRequests("```json\n" + JSON.stringify(request) + "\n```")).toThrow(
      "button menu: ios support",
    );
  });

  test("rejects iOS key requests despite wire-parser acceptance", () => {
    const request = {
      id: "key",
      type: "daemon_request",
      method: "input/key",
      params: { platform: "ios", key: "enter" },
    };
    expect(() => validateRequests("```json\n" + JSON.stringify(request) + "\n```")).toThrow(
      "input/key is Android-only",
    );
  });

  test("rejects documented-but-dropped cancel in table and JSON requests", () => {
    expect(() => validateTableRow("`input/tap`", "`platform`, `x`, `y`, `cancel?`")).toThrow(
      "param cancel not retained",
    );
    const badDoc =
      '```json\n{"id":"bad","type":"daemon_request","method":"input/tap","params":{"platform":"android","x":1,"y":2,"cancel":true}}\n```';
    expect(() => validateRequests(badDoc)).toThrow("param cancel not retained");
  });

  test("rejects incorrectly mapped mode and missing retained frameContext", () => {
    expect(() =>
      validateParsedParams("input/typeText", { mode: "append" }, ["mode?"], { append: false }),
    ).toThrow("param mode mapped incorrectly to append");
    expect(() =>
      validateParsedParams("input/tap", { frameContext: "frame-1" }, ["frameContext?"], {}),
    ).toThrow("param frameContext not retained");
  });

  test("rejects undocumented parser output even when its value is undefined or a default", () => {
    expect(() => validateTableRow("`input/tap`", "`platform`, `x`, `y`")).toThrow(
      "undocumented parsed key deviceId",
    );
    expect(() => validateParsedParams("input/typeText", {}, [], { append: false })).toThrow(
      "undocumented parsed key append",
    );
  });

  test("documents integer duration units, swipe bounds, and default", () => {
    validateDurationDocs(doc);
    expect(() =>
      validateDurationDocs(doc.replace("optional integer number", "optional finite number")),
    ).toThrow("tap duration must document integer milliseconds");
  });

  for (const platform of ["android", "ios"]) {
    test(`tap rejects fractional duration on ${platform}; integers and omission retain values`, () => {
      const params = { platform, x: 1, y: 2 };
      for (const duration of [1.5, NaN, Infinity, -Infinity, "100"]) {
        expect(() => server["parseInputTapParams"]({ ...params, duration })).toThrow(
          "integer number of milliseconds",
        );
      }
      expect(server["parseInputTapParams"]({ ...params, duration: 100 }).duration).toBe(100);
      expect(server["parseInputTapParams"](params).duration).toBeUndefined();
    });

    test(`swipe rejects fractional durationMs on ${platform}; integers, boundaries and omission retain values`, () => {
      const params = { platform, startX: 1, startY: 2, endX: 3, endY: 4 };
      for (const durationMs of [1.5, 0, 60_001, NaN, Infinity, -Infinity, "450"]) {
        expect(() => server["parseInputSwipeParams"]({ ...params, durationMs })).toThrow(
          "integer milliseconds between 1 and 60000",
        );
      }
      for (const durationMs of [1, 450, 60_000]) {
        expect(server["parseInputSwipeParams"]({ ...params, durationMs }).durationMs).toBe(
          durationMs,
        );
      }
      expect(server["parseInputSwipeParams"](params).durationMs).toBe(300);
    });
  }

  test("JSON guard rejects fractional tap and swipe duration samples", () => {
    for (const [method, params] of [
      ["input/tap", { platform: "android", x: 1, y: 2, duration: 1.5 }],
      [
        "input/swipe",
        { platform: "android", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 1.5 },
      ],
    ]) {
      const request = { id: "fraction", type: "daemon_request", method, params };
      expect(() => validateRequests("```json\n" + JSON.stringify(request) + "\n```")).toThrow(
        "integer",
      );
    }
  });
});
