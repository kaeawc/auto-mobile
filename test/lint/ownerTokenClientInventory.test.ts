import { readGuardFile } from "./astGuard";
// Step 2 of #11555 (refuse tokenless) must move a client row to "sends" before refusing it.
import { expect, test } from "bun:test";

import { join } from "node:path";
import { DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM } from "../../src/daemon/wire/constants";

const root = join(import.meta.dir, "../..");
const clients = [
  // Pre-existing rows are compatibility pins; the JUnit sends row is this step's regression.
  // Not one-shot --cli or declared-CLI proxies: see withOwnedSessionCapabilities.
  ["src/daemon/mcpProxy/ProxyToolRouting.ts", "sends"],
  [
    "android/junit-runner/src/main/kotlin/dev/jasonpearson/automobile/junit/DaemonSocketClient.kt",
    "sends",
  ],
  ["src/daemon/client/client.ts", "tokenless"],
  [
    "android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/daemon/McpDaemonClient.kt",
    "tokenless",
  ],
  [
    "android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/daemon/McpHttpClient.kt",
    "tokenless",
  ],
  [
    "android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/daemon/McpStdioClient.kt",
    "tokenless",
  ],
  ["ios/XCTestRunner/Sources/XCTestRunner/MCP/AutoMobileDaemonClient.swift", "tokenless"],
  ["ios/XCTestRunner/Sources/XCTestRunner/MCP/StreamableHTTPMCPClient.swift", "tokenless"],
] as const;

test.each(clients)("first-party client %s is %s", (path, ownership) => {
  const source = readGuardFile(join(root, path));
  const sends =
    source.includes("__autoMobileOwnedSessionsOwnerToken") ||
    source.includes("DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM");
  expect(sends).toBe(ownership === "sends");
});

test("JUnit wire literal matches the daemon constant and heartbeat carries its owner field", () => {
  const socket = readGuardFile(
    join(
      root,
      "android/junit-runner/src/main/kotlin/dev/jasonpearson/automobile/junit/DaemonSocketClient.kt",
    ),
  );
  expect(DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM).toBe("__autoMobileOwnedSessionsOwnerToken");
  expect(socket).toContain(`"${DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM}"`);
  expect(
    readGuardFile(
      join(
        root,
        "android/junit-runner/src/main/kotlin/dev/jasonpearson/automobile/junit/HeartbeatTransport.kt",
      ),
    ),
  ).toContain('"livenessOwnerToken"');
});
