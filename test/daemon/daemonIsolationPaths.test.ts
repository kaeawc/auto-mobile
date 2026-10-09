import { describe, expect, test } from "bun:test";
import {
  resolveDaemonIsolationSuffix,
  resolveDaemonStatePath,
  resolveIsolatedDaemonStatePath,
} from "../../src/daemon/constants";
import vectors from "../fixtures/daemon-isolation-paths.json";

describe("daemon isolation state paths (issue #10871)", () => {
  test("without an aux socket dir the resident unsuffixed paths are used", () => {
    expect(resolveIsolatedDaemonStatePath("sock", {}, "501")).toBe(
      "/tmp/auto-mobile-daemon-501.sock",
    );
    expect(resolveIsolatedDaemonStatePath("pid", { AUTOMOBILE_AUX_SOCKET_DIR: "  " }, "501")).toBe(
      "/tmp/auto-mobile-daemon-501.pid",
    );
  });

  test("an aux socket dir moves socket, pid and lock off the resident paths", () => {
    const env = { AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/lane/aux" };
    const paths = (["sock", "pid", "lock"] as const).map((ext) =>
      resolveIsolatedDaemonStatePath(ext, env, "501"),
    );
    for (const p of paths) {
      expect(p).toMatch(/^\/tmp\/auto-mobile-daemon-501-[0-9a-f]{10}\.(sock|pid|lock)$/);
    }
    expect(paths).not.toContain("/tmp/auto-mobile-daemon-501.sock");
  });

  test("paths are stable per dir, distinct across dirs, and short for deep dirs", () => {
    const a = { AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/a" };
    const b = { AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/b" };
    expect(resolveDaemonIsolationSuffix(a)).toBe(resolveDaemonIsolationSuffix({ ...a }));
    expect(resolveDaemonIsolationSuffix(a)).not.toBe(resolveDaemonIsolationSuffix(b));
    const deep = { AUTOMOBILE_AUX_SOCKET_DIR: `/tmp/${"x".repeat(300)}` };
    expect(resolveIsolatedDaemonStatePath("sock", deep, "501").length).toBeLessThan(100);
  });
});

describe("shared daemon state-path vectors (#10906)", () => {
  // The JUnit runner, desktop app and XCTestRunner test their ports against the same file.
  for (const vector of vectors.cases) {
    test.skipIf(vector.posixOnly && process.platform === "win32")(vector.name, () => {
      const env: NodeJS.ProcessEnv = vector.env;
      expect(resolveDaemonIsolationSuffix(env)).toBe(vector.suffix);
      expect(resolveDaemonStatePath("sock", env, vectors.uid)).toBe(vector.socketPath);
      expect(resolveDaemonStatePath("pid", env, vectors.uid)).toBe(vector.pidFilePath);
      expect(resolveDaemonStatePath("lock", env, vectors.uid)).toBe(vector.lockFilePath);
    });
  }
});
