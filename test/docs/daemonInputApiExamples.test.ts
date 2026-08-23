import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_CHECKSUM_REGISTRY } from "../../src/constants/release";

const repoRoot = join(import.meta.dir, "../..");
const defaultReleaseVersion = RELEASE_CHECKSUM_REGISTRY[0].version;

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf-8");
}

const implementedInputMethods = [
  "input/tap",
  "input/swipe",
  "input/pressButton",
  "input/typeText",
  "input/key",
] as const;

type ImplementedInputMethod = (typeof implementedInputMethods)[number];

function extractRawSocketExampleSection(markdown: string): string {
  const start = markdown.indexOf("### Copy-paste raw socket examples");
  const end = markdown.indexOf("### `input/tap`", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return markdown.slice(start, end);
}

function parseRequestExamples(section: string): Array<Record<string, unknown>> {
  return Array.from(
    section.matchAll(/printf '%s\\n' '([^']+)'/g),
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
}

function parseResponseExamples(section: string): Array<Record<string, unknown>> {
  const responseStart = section.indexOf("Example success responses:");
  expect(responseStart).toBeGreaterThanOrEqual(0);
  return section
    .slice(responseStart)
    .split("\n")
    .filter((line) => line.startsWith('{ "id":'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("daemon input API consumer docs", () => {
  test("show raw socket request and response examples for every implemented input endpoint", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");
    const rawExampleSection = extractRawSocketExampleSection(unixSocketApi);
    const requestExamples = parseRequestExamples(rawExampleSection);
    const responseExamples = parseResponseExamples(rawExampleSection);
    const requestsByMethod = new Map(
      requestExamples.map((request) => [String(request.method), request]),
    );
    const responsesByAction = new Map(
      responseExamples.map((response) => {
        const result = response.result as Record<string, unknown>;
        return [String(result.action), response];
      }),
    );

    expect(unixSocketApi).toContain("Copy-paste raw socket examples");
    expect(unixSocketApi).toContain("printf '%s\\n'");
    expect(unixSocketApi).toContain('nc -U -w 2 "$AUTOMOBILE_DAEMON_SOCKET_PATH"');
    expect(requestExamples).toHaveLength(implementedInputMethods.length);
    expect(responseExamples).toHaveLength(implementedInputMethods.length);

    const expectedParamsByMethod: Record<ImplementedInputMethod, Record<string, unknown>> = {
      "input/tap": {
        platform: "android",
        deviceId: "emulator-5554",
        x: 240,
        y: 640,
        duration: 50,
        frameContext: "android-generation-42",
      },
      "input/swipe": {
        platform: "android",
        deviceId: "emulator-5554",
        startX: 520,
        startY: 1700,
        endX: 520,
        endY: 500,
        durationMs: 350,
        frameContext: "android-generation-42",
      },
      "input/pressButton": {
        platform: "android",
        deviceId: "emulator-5554",
        button: "back",
        frameContext: "android-generation-42",
      },
      "input/typeText": {
        platform: "android",
        deviceId: "emulator-5554",
        text: "hello from socket",
        submit: false,
        frameContext: "android-generation-42",
      },
      "input/key": {
        platform: "android",
        deviceId: "emulator-5554",
        key: "enter",
        frameContext: "android-generation-42",
      },
    };
    const expectedResultByMethod: Record<ImplementedInputMethod, Record<string, unknown>> = {
      "input/tap": {
        action: "input/tap",
        platform: "android",
        deviceId: "emulator-5554",
        success: true,
        coordinates: { x: 240, y: 640 },
      },
      "input/swipe": {
        action: "input/swipe",
        platform: "android",
        deviceId: "emulator-5554",
        success: true,
        start: { x: 520, y: 1700 },
        end: { x: 520, y: 500 },
        durationMs: 350,
      },
      "input/pressButton": {
        action: "input/pressButton",
        platform: "android",
        deviceId: "emulator-5554",
        success: true,
        button: "back",
      },
      "input/typeText": {
        action: "input/typeText",
        platform: "android",
        deviceId: "emulator-5554",
        success: true,
        textLength: 17,
        submitted: false,
      },
      "input/key": {
        action: "input/key",
        platform: "android",
        deviceId: "emulator-5554",
        success: true,
        key: "enter",
      },
    };

    for (const method of implementedInputMethods) {
      expect(requestsByMethod.get(method)).toMatchObject({
        type: "mcp_request",
        method,
        params: expectedParamsByMethod[method],
      });
      expect(responsesByAction.get(method)).toMatchObject({
        type: "mcp_response",
        success: true,
        result: expectedResultByMethod[method],
      });
    }
  });

  test("documents frame-context pairing, echoing, and recovery for third-party screen control", async () => {
    const clientGuide = await readRepoFile("docs/design-docs/mcp/daemon/client-screen-control.md");
    const snapshotGuide = await readRepoFile(
      "docs/design-docs/mcp/daemon/client-frame-snapshot.md",
    );
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");

    expect(clientGuide).toContain('"frameContext": "android-generation-42"');
    expect(clientGuide).toContain(
      "`screenshot.frameContext == hierarchy.frameContext`, with both values non-null",
    );
    expect(clientGuide).toContain("opaque `frameContext` on every request");
    expect(clientGuide).toContain("stale-context rejection");
    expect(clientGuide).toContain("wait for a newly paired snapshot before");
    expect(clientGuide).toContain(
      "runner that does not publish `frameContext` cannot produce a controllable",
    );
    expect(clientGuide).toContain(
      `default \`${defaultReleaseVersion}\` CtrlProxy artifacts predate \`frameContext\``,
    );
    expect(clientGuide).toContain("does not yet implement `frameContext` pairing or echoing");
    expect(clientGuide).toContain("[#4596](https://github.com/kaeawc/auto-mobile/issues/4596)");
    expect(clientGuide).toContain("having the gesture guarantee");
    expect(snapshotGuide).toContain(
      `default \`${defaultReleaseVersion}\` CtrlProxy artifacts predate this protocol`,
    );
    expect(snapshotGuide).toContain("Legacy desktop implementation");
    expect(snapshotGuide).toContain("does not pair or echo `frameContext`");
    expect(snapshotGuide).toMatch(/not a reference implementation for\s+this protocol/);
    expect(snapshotGuide).toMatch(
      /`input\/tap` and `input\/swipe`, the\s+daemon rejects a stale echoed context/,
    );
    expect(snapshotGuide).toContain("[#4586](https://github.com/kaeawc/auto-mobile/issues/4586)");
    expect(unixSocketApi).toContain("`frameContext` | `string` | No |");
    expect(unixSocketApi).toContain(
      `default \`${defaultReleaseVersion}\` CtrlProxy artifacts are legacy`,
    );
    expect(unixSocketApi).toContain(
      "device-boundary guarantee applies to `input/tap`, `input/swipe`, `input/pressButton`",
    );
    expect(unixSocketApi).toMatch(
      /"duration": 50,\r?\n    "frameContext": "android-generation-42"/,
    );
    expect(unixSocketApi).toMatch(
      /"durationMs": 350,\r?\n    "frameContext": "android-generation-42"/,
    );
    expect(unixSocketApi).toMatch(
      /"button": "back",\r?\n    "frameContext": "android-generation-42"/,
    );
    expect(unixSocketApi).toMatch(
      /"submit": false,\r?\n    "frameContext": "android-generation-42"/,
    );
    expect(unixSocketApi).toMatch(
      /"mode": "append",\r?\n    "frameContext": "android-generation-42"/,
    );
    expect(unixSocketApi).toMatch(
      /"key": "enter",\r?\n    "frameContext": "android-generation-42"/,
    );
  });

  test("frames direct input as input methods and tools/call as fallback", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");

    expect(unixSocketApi).toContain("Use the `input/*` methods for direct consumer input");
    expect(unixSocketApi).toContain("Use `tools/call` as a fallback");
    expect(unixSocketApi).toContain("non-input MCP tools");
  });

  test("documents platform support, unsupported behavior, observations, and key input platform gaps", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");

    const expectedStatusRows = [
      "| `input/tap` | Supported | Supported | Absolute device-screen coordinates. |",
      "| `input/swipe` | Supported | Supported | Absolute device-screen start/end coordinates. Use for drag gestures until `input/drag` has distinct semantics. |",
      "| `input/pressButton` | Supported | Supported with platform gaps | Device/navigation buttons aligned with MCP `pressButton`. Unsupported buttons fail instead of being ignored. |",
      "| `input/typeText` | Supported | Supported | Sends committed text only; IME composition is deferred. " +
        'Non-destructive `mode: "append"` is supported on both platforms. |',
      "| `input/key` | Supported | Unsupported | Discrete non-text key presses. Modifiers are deferred. |",
    ];

    for (const row of expectedStatusRows) {
      expect(unixSocketApi).toContain(row);
    }

    // The append mode is the only non-destructive keyboard path a third-party client
    // has; document its support on both platforms and Android's character limitation.
    expect(unixSocketApi).toContain('| `mode` | `"append"` | No |');
    expect(unixSocketApi).toContain(
      "**iOS.** Append dispatches to CtrlProxy's focused-field insert primitive",
    );
    expect(unixSocketApi).toContain("append cannot type");
    expect(unixSocketApi).toContain('"mode": "append"');

    expect(unixSocketApi).toContain(
      "Unsupported platforms or unsupported actions return `success: false`",
    );
    expect(unixSocketApi).toContain("do not include a fresh observation");
    expect(unixSocketApi).not.toContain("Unsupported input action input/key on ios");
    expect(unixSocketApi).toContain("input/key is unsupported on ios");
    expect(unixSocketApi).toContain("iOS simulators return clear unsupported errors for");
  });

  test("documents the additive append-mode capability query with the normal socket handshake", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");

    expect(unixSocketApi).toContain("### `daemon/capabilities`");
    expect(unixSocketApi).toContain('"input/typeText.mode:append"');
    expect(unixSocketApi).toContain("remains subject to the normal socket version");
    expect(unixSocketApi).toContain(
      "subject to the normal socket version and build-identity handshake; clients must surface a mismatch",
    );
    expect(unixSocketApi).toContain("that leaves append support unknown");
    expect(unixSocketApi).toContain(
      "translate only the exact `input/typeText unsupported params: mode` response",
    );
    expect(unixSocketApi).toContain("Unsupported daemon method: daemon/capabilities");
    expect(unixSocketApi).toContain('"clientVersion": "1.2.3"');
    expect(unixSocketApi).toContain('"clientBuildId": "sha256:..."');
    expect(unixSocketApi).toContain('"clientEntryScript": "/absolute/path/to/client-entry.js"');
  });

  test("documents pressButton values that the socket actually accepts", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");

    expect(unixSocketApi).toContain(
      '"back" \\| "home" \\| "app_switch" \\| "volume_up" \\| "volume_down" \\| "power"',
    );
    expect(unixSocketApi).toContain("`input/key` for a discrete Enter press");
    expect(unixSocketApi).not.toContain('"power" \\| "enter"');
    expect(unixSocketApi).not.toContain("`enter` is reserved by the socket contract");
  });

  test("links future IDE screen control docs to the daemon input API", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");
    const screenStreaming = await readRepoFile("docs/design-docs/mcp/observe/screen-streaming.md");
    const androidIde = await readRepoFile("docs/design-docs/plat/android/ide-plugin/overview.md");

    expect(unixSocketApi).toContain("[Screen Streaming](../observe/screen-streaming.md)");
    expect(screenStreaming).toContain("[daemon input API](../daemon/unix-socket-api.md#input-api)");
    expect(androidIde).toContain(
      "[daemon input API](../../../mcp/daemon/unix-socket-api.md#input-api)",
    );
  });
});
