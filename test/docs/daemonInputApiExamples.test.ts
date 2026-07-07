import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

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

type ImplementedInputMethod = typeof implementedInputMethods[number];

function extractRawSocketExampleSection(markdown: string): string {
  const start = markdown.indexOf("### Copy-paste raw socket examples");
  const end = markdown.indexOf("### `input/tap`", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return markdown.slice(start, end);
}

function parseRequestExamples(section: string): Array<Record<string, unknown>> {
  return Array.from(section.matchAll(/printf '%s\\n' '([^']+)'/g), match =>
    JSON.parse(match[1]) as Record<string, unknown>
  );
}

function parseResponseExamples(section: string): Array<Record<string, unknown>> {
  const responseStart = section.indexOf("Example success responses:");
  expect(responseStart).toBeGreaterThanOrEqual(0);
  return section
    .slice(responseStart)
    .split("\n")
    .filter(line => line.startsWith("{ \"id\":"))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("daemon input API consumer docs", () => {
  test("show raw socket request and response examples for every implemented input endpoint", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");
    const rawExampleSection = extractRawSocketExampleSection(unixSocketApi);
    const requestExamples = parseRequestExamples(rawExampleSection);
    const responseExamples = parseResponseExamples(rawExampleSection);
    const requestsByMethod = new Map(
      requestExamples.map(request => [String(request.method), request])
    );
    const responsesByAction = new Map(
      responseExamples.map(response => {
        const result = response.result as Record<string, unknown>;
        return [String(result.action), response];
      })
    );

    expect(unixSocketApi).toContain("Copy-paste raw socket examples");
    expect(unixSocketApi).toContain("printf '%s\\n'");
    expect(unixSocketApi).toContain("nc -U \"$AUTOMOBILE_DAEMON_SOCKET_PATH\"");
    expect(requestExamples).toHaveLength(implementedInputMethods.length);
    expect(responseExamples).toHaveLength(implementedInputMethods.length);

    const expectedParamsByMethod: Record<ImplementedInputMethod, Record<string, unknown>> = {
      "input/tap": {
        platform: "android",
        deviceId: "emulator-5554",
        x: 240,
        y: 640,
        duration: 50,
      },
      "input/swipe": {
        platform: "android",
        deviceId: "emulator-5554",
        startX: 520,
        startY: 1700,
        endX: 520,
        endY: 500,
        durationMs: 350,
      },
      "input/pressButton": {
        platform: "android",
        deviceId: "emulator-5554",
        button: "back",
      },
      "input/typeText": {
        platform: "android",
        deviceId: "emulator-5554",
        text: "hello from socket",
        submit: false,
      },
      "input/key": {
        platform: "android",
        deviceId: "emulator-5554",
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
        result: {
          action: method,
          platform: "android",
          deviceId: "emulator-5554",
          success: true,
        },
      });
    }
  });

  test("frames direct input as input methods and tools/call as fallback", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");

    expect(unixSocketApi).toContain("Use the `input/*` methods for direct consumer input");
    expect(unixSocketApi).toContain("Use `tools/call` as a fallback");
    expect(unixSocketApi).toContain("non-input MCP tools");
  });

  test("documents platform support, unsupported behavior, observations, and key input platform gaps", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");

    expect(unixSocketApi).toContain("| `input/key` | Supported | Unsupported | Discrete non-text key presses. Modifiers are deferred. |");
    expect(unixSocketApi).toContain("Unsupported platforms or unsupported actions return `success: false`");
    expect(unixSocketApi).toContain("do not include a fresh observation");
    expect(unixSocketApi).toContain("input/key is unsupported on ios");
  });

  test("links future IDE screen control docs to the daemon input API", async () => {
    const unixSocketApi = await readRepoFile("docs/design-docs/mcp/daemon/unix-socket-api.md");
    const screenStreaming = await readRepoFile("docs/design-docs/mcp/observe/screen-streaming.md");
    const androidIde = await readRepoFile("docs/design-docs/plat/android/ide-plugin/overview.md");
    const iosIde = await readRepoFile("docs/design-docs/plat/ios/ide-plugin/overview.md");

    expect(unixSocketApi).toContain("[Screen Streaming](../observe/screen-streaming.md)");
    expect(screenStreaming).toContain("[daemon input API](../daemon/unix-socket-api.md#input-api)");
    expect(androidIde).toContain("[daemon input API](../../../mcp/daemon/unix-socket-api.md#input-api)");
    expect(iosIde).toContain("[daemon input API](../../../mcp/daemon/unix-socket-api.md#input-api)");
  });
});
