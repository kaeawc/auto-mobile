import { describe, expect, test } from "bun:test";
import * as daemonFiles from "../../src/daemon/daemonFiles";
import type { SocketServerConfig } from "../../src/daemon/socketServer/index";

/**
 * Guard for issue #4195.
 *
 * `video-stream.sock` was started by the daemon while being absent from both
 * socket registries, so it was never published and never unlinked. The registry
 * is now a single exhaustive `Record` keyed by `AuxiliaryDaemonSocketName`, which
 * makes the *type* side unforgeable; this test closes the other direction — a
 * socket config declared in `daemonFiles.ts` but never wired into the registry.
 */
describe("daemon socket registry coverage", () => {
  const declaredConfigs = Object.entries(daemonFiles).filter(
    (entry): entry is [string, SocketServerConfig] => entry[0].endsWith("_SOCKET_CONFIG"),
  );

  test("every declared socket config is reachable from daemonFiles exports", () => {
    expect(declaredConfigs.length).toBeGreaterThan(0);
  });

  test("every declared socket config is registered for publication and cleanup", () => {
    const registered = new Set<SocketServerConfig>(
      Object.values(daemonFiles.AUXILIARY_SOCKET_CONFIGS_BY_NAME),
    );

    const unregistered = declaredConfigs
      .filter(([, config]) => !registered.has(config))
      .map(([exportName]) => exportName);

    expect(unregistered).toEqual([]);
  });

  test("registry has no duplicate config entries", () => {
    const configs = Object.values(daemonFiles.AUXILIARY_SOCKET_CONFIGS_BY_NAME);
    expect(new Set(configs).size).toBe(configs.length);
  });
});
