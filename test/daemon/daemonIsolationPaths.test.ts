import { describe, expect, test } from "bun:test";
import {
  resolveDaemonIsolationSuffix,
  resolveIsolatedDaemonStatePath,
} from "../../src/daemon/constants";

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
