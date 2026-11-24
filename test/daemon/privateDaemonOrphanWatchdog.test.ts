import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PRIVATE_DAEMON_ORPHAN_IDLE_MS,
  PrivateDaemonOrphanWatchdog,
  HARNESS_PRIVATE_DAEMON_ENV,
  DAEMON_LAUNCHER_PID_ENV,
  isControlSocketRemoved,
  isHarnessPrivateDaemon,
  resolveLauncherPid,
  resolvePrivateDaemonOrphanIdleMs,
  type PrivateDaemonOrphanPort,
} from "../../src/daemon/privateDaemonOrphanWatchdog";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";

const IDLE_MS = 10 * 60_000;

class FakeOrphanPort implements PrivateDaemonOrphanPort {
  ppid = 1;
  launcher = 4242;
  explicit = false;
  alive = new Set<number>();
  clients = 0;
  sessions = 0;
  shutdowns: string[] = [];
  socketRemoved = false;
  controlSocketRemoved(): boolean {
    return this.socketRemoved;
  }
  parentPid(): number {
    return this.ppid;
  }
  launcherPid(): number {
    return this.launcher;
  }
  launcherIsExplicit(): boolean {
    return this.explicit;
  }
  isProcessRunning(pid: number): boolean {
    return this.alive.has(pid);
  }
  clientCount(): number {
    return this.clients;
  }
  /** Connections or requests ever accepted. */
  accepted = 0;
  clientActivityCount(): number {
    return this.accepted;
  }
  liveSessionCount(): number {
    return this.sessions;
  }
  shutdown(reason: string): void {
    this.shutdowns.push(reason);
  }
}

describe("PrivateDaemonOrphanWatchdog (#10497)", () => {
  test.each(["different", "same", "unknown", "unavailable", "non-explicit", "disabled"] as const)(
    "launcher generation handles %s",
    (verdict) => {
      const timer = new FakeTimer();
      const port = new FakeOrphanPort();
      const generation = new FakeLockOwnerGenerationProbe();
      port.explicit = verdict !== "non-explicit";
      port.ppid = port.launcher;
      port.alive.add(port.launcher);
      if (verdict === "unavailable") {
        generation.token = undefined;
      }
      if (verdict === "different" || verdict === "same" || verdict === "unknown") {
        generation.verdict = verdict;
      }
      const watchdog = new PrivateDaemonOrphanWatchdog(
        port,
        verdict === "disabled" ? 0 : IDLE_MS,
        timer,
        { checkIntervalMs: 30_000, launcherGeneration: generation },
      );
      watchdog.start();
      watchdog.start();
      expect(generation.currentCalls).toEqual(
        ["non-explicit", "disabled"].includes(verdict) ? [] : [port.launcher],
      );
      expect(watchdog.check()).toBe(false);
      timer.setCurrentTime(IDLE_MS);
      expect(watchdog.check()).toBe(verdict === "different");
      expect(port.shutdowns).toHaveLength(verdict === "different" ? 1 : 0);
      if (["non-explicit", "disabled", "unavailable"].includes(verdict)) {
        expect(generation.compareCalls).toEqual([]);
      }
      watchdog.stop();
    },
  );
  let timer: FakeTimer;
  let port: FakeOrphanPort;
  let watchdog: PrivateDaemonOrphanWatchdog;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(0);
    port = new FakeOrphanPort();
    watchdog = new PrivateDaemonOrphanWatchdog(port, IDLE_MS, timer);
  });

  test("shuts down an orphaned daemon with no clients after its idle timeout", () => {
    expect(watchdog.check()).toBe(false);
    timer.setCurrentTime(IDLE_MS - 1);
    expect(watchdog.check()).toBe(false);
    timer.setCurrentTime(IDLE_MS);
    expect(watchdog.check()).toBe(true);
    expect(port.shutdowns).toHaveLength(1);
    expect(watchdog.check()).toBe(false);
  });

  test("shuts down when a Linux subreaper (ppid not 1) adopts the daemon", () => {
    port.ppid = 777;
    expect(watchdog.check()).toBe(false);
    timer.setCurrentTime(IDLE_MS);
    expect(watchdog.check()).toBe(true);
    expect(port.shutdowns).toHaveLength(1);
  });

  test("never shuts down while the launching parent is alive", () => {
    port.ppid = 4242;
    watchdog.check();
    timer.setCurrentTime(IDLE_MS * 10);
    expect(watchdog.check()).toBe(false);
  });

  test("a client or session resets the idle clock", () => {
    watchdog.check();
    timer.setCurrentTime(IDLE_MS - 1);
    port.clients = 1;
    expect(watchdog.check()).toBe(false);
    port.clients = 0;
    port.sessions = 1;
    timer.setCurrentTime(IDLE_MS * 2);
    expect(watchdog.check()).toBe(false);
    port.sessions = 0;
    expect(watchdog.check()).toBe(false);
    timer.setCurrentTime(IDLE_MS * 3);
    expect(watchdog.check()).toBe(true);
  });

  test("short-lived clients between checks reset the idle clock (#10506 review)", () => {
    watchdog.check();
    // A status request opens and closes between two checks: never seen as open.
    timer.setCurrentTime(IDLE_MS - 1);
    port.accepted += 1;
    expect(watchdog.check()).toBe(false);
    timer.setCurrentTime(IDLE_MS);
    expect(watchdog.check()).toBe(false);
    timer.setCurrentTime(IDLE_MS * 2);
    expect(watchdog.check()).toBe(true);
  });

  test("an alive explicit launcher behind an intermediate parent is not orphaned (#11370)", () => {
    port.explicit = true;
    port.launcher = 400;
    port.ppid = 500;
    port.alive.add(400);
    watchdog.check();
    timer.setCurrentTime(IDLE_MS * 10);
    expect(watchdog.check()).toBe(false);
    expect(port.shutdowns).toEqual([]);
  });

  test("a dead explicit launcher behind an intermediate parent is orphaned (#11370)", () => {
    port.explicit = true;
    port.launcher = 400;
    port.ppid = 500;
    expect(watchdog.check()).toBe(false);
    timer.setCurrentTime(IDLE_MS);
    expect(watchdog.check()).toBe(true);
    expect(port.shutdowns).toHaveLength(1);
  });

  test("an explicit launcher does not keep a daemon adopted by init (#11370)", () => {
    port.explicit = true;
    port.launcher = 400;
    port.ppid = 1;
    port.alive.add(400);
    watchdog.check();
    timer.setCurrentTime(IDLE_MS);
    expect(watchdog.check()).toBe(true);
  });

  test("without an explicit launcher a changed parent still orphans (#11370)", () => {
    port.ppid = 777;
    port.alive.add(4242);
    watchdog.check();
    timer.setCurrentTime(IDLE_MS);
    expect(watchdog.check()).toBe(true);
  });

  test("checks on the injected timer once started", async () => {
    watchdog.start();
    await timer.advanceTimeAsync(IDLE_MS + 30_000);
    expect(port.shutdowns).toHaveLength(1);
    watchdog.stop();
  });

  test("arms only for harness-style private daemons, never a custom long-lived socket", () => {
    const defaultSocket = "/tmp/auto-mobile-daemon-501.sock";
    const harnessEnv = {
      AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/priv/daemon.sock",
      AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/priv/aux",
    };
    expect(isHarnessPrivateDaemon("/tmp/priv/daemon.sock", defaultSocket, harnessEnv)).toBe(true);
    // A user's own daemon on a custom control socket, with shared aux sockets.
    expect(isHarnessPrivateDaemon("/Users/me/am.sock", defaultSocket, {})).toBe(false);
    expect(
      isHarnessPrivateDaemon("/Users/me/am.sock", defaultSocket, {
        AUTOMOBILE_AUX_SOCKET_DIR: " ",
      }),
    ).toBe(false);
    expect(isHarnessPrivateDaemon(defaultSocket, defaultSocket, harnessEnv)).toBe(false);
    expect(resolvePrivateDaemonOrphanIdleMs({})).toBe(DEFAULT_PRIVATE_DAEMON_ORPHAN_IDLE_MS);
    expect(
      resolvePrivateDaemonOrphanIdleMs({ AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: "0" }),
    ).toBe(0);
    // A blank value is unset (the default), not 0; only an explicit "0" disables the watchdog.
    for (const blank of ["", "  "]) {
      expect(
        resolvePrivateDaemonOrphanIdleMs({ AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: blank }),
      ).toBe(DEFAULT_PRIVATE_DAEMON_ORPHAN_IDLE_MS);
    }
  });

  test("an aux-dir-only daemon's suffixed socket is not a harness marker (#10906)", () => {
    const defaultSocket = "/tmp/auto-mobile-daemon-501.sock";
    // #10881: AUTOMOBILE_AUX_SOCKET_DIR alone moves the control socket to a suffixed path.
    const suffixedSocket = "/tmp/auto-mobile-daemon-501-0123456789.sock";
    const auxOnly = { AUTOMOBILE_AUX_SOCKET_DIR: "/Users/me/am-aux" };
    expect(isHarnessPrivateDaemon(suffixedSocket, defaultSocket, auxOnly)).toBe(false);
  });

  test("the explicit harness marker arms or disarms the watchdog regardless of paths", () => {
    const defaultSocket = "/tmp/auto-mobile-daemon-501.sock";
    const suffixedSocket = "/tmp/auto-mobile-daemon-501-0123456789.sock";
    expect(
      isHarnessPrivateDaemon(suffixedSocket, defaultSocket, {
        [HARNESS_PRIVATE_DAEMON_ENV]: "1",
        AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/lane/aux",
      }),
    ).toBe(true);
    expect(
      isHarnessPrivateDaemon(defaultSocket, defaultSocket, { [HARNESS_PRIVATE_DAEMON_ENV]: "1" }),
    ).toBe(true);
    expect(
      isHarnessPrivateDaemon("/tmp/priv/daemon.sock", defaultSocket, {
        [HARNESS_PRIVATE_DAEMON_ENV]: "0",
        AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/priv/daemon.sock",
        AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/priv/aux",
      }),
    ).toBe(false);
  });

  test("a zero idle timeout disables the watchdog", async () => {
    const disabled = new PrivateDaemonOrphanWatchdog(port, 0, timer);
    disabled.start();
    await timer.advanceTimeAsync(IDLE_MS * 10);
    expect(port.shutdowns).toEqual([]);
  });
});

describe("resolveLauncherPid (#11041)", () => {
  test("uses the parent pid captured at process entry by default", () => {
    expect(resolveLauncherPid(4242, {})).toBe(4242);
  });

  test("a launcher-provided pid wins over a late-read subreaper pid", () => {
    expect(resolveLauncherPid(777, { [DAEMON_LAUNCHER_PID_ENV]: "4242" })).toBe(4242);
  });

  test.each(["", "abc", "0", "1", "-5", "12.5"])("ignores invalid launcher pid %p", (value) => {
    expect(resolveLauncherPid(4242, { [DAEMON_LAUNCHER_PID_ENV]: value })).toBe(4242);
  });
});

describe("PrivateDaemonOrphanWatchdog control-socket removal (#19132)", () => {
  // A launcher that deleted its socket dir but kept AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS=0
  // left the daemon unreachable and holding a port forever.
  test("shuts down an idle-check-disabled daemon whose control socket was removed", () => {
    const timer = new FakeTimer();
    const port = new FakeOrphanPort();
    port.ppid = port.launcher;
    const watchdog = new PrivateDaemonOrphanWatchdog(port, 0, timer);
    watchdog.start();
    timer.advanceTime(30_000);
    expect(port.shutdowns).toEqual([]);
    port.socketRemoved = true;
    timer.advanceTime(30_000);
    expect(port.shutdowns).toEqual([]);
    timer.advanceTime(30_000);
    expect(port.shutdowns).toEqual([
      "private daemon's control socket was removed and it has no clients",
    ]);
    timer.advanceTime(60_000);
    expect(port.shutdowns).toHaveLength(1);
  });

  test("an open client or a restored socket resets the removal count", () => {
    const port = new FakeOrphanPort();
    port.ppid = port.launcher;
    const watchdog = new PrivateDaemonOrphanWatchdog(port, IDLE_MS, new FakeTimer());
    port.socketRemoved = true;
    expect(watchdog.check()).toBe(false);
    port.clients = 1;
    expect(watchdog.check()).toBe(false);
    port.clients = 0;
    expect(watchdog.check()).toBe(false);
    port.socketRemoved = false;
    expect(watchdog.check()).toBe(false);
    port.socketRemoved = true;
    expect(watchdog.check()).toBe(false);
    expect(watchdog.check()).toBe(true);
    expect(port.shutdowns).toHaveLength(1);
  });

  test("the launcher env shape behind #19132 arms the watchdog", () => {
    expect(
      isHarnessPrivateDaemon("/tmp/srs-am.iERu/d.sock", "/tmp/auto-mobile-daemon-501.sock", {
        AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/srs-am.iERu/d.sock",
        AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/srs-am.iERu",
        AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: "0",
      }),
    ).toBe(true);
  });
});

describe("isControlSocketRemoved (#19132)", () => {
  const fsWith = (exists: boolean) => ({
    exists: () => exists,
    stat: () => ({ dev: 1n, ino: 2n }),
  });

  test("is false while the server is not listening, even though the path is gone", () => {
    expect(isControlSocketRemoved({ isListening: () => false }, "/s.sock", fsWith(false))).toBe(
      false,
    );
    expect(isControlSocketRemoved(null, "/s.sock", fsWith(false))).toBe(false);
  });

  test("is true only when listening and the path is gone", () => {
    expect(isControlSocketRemoved({ isListening: () => true }, "/s.sock", fsWith(false))).toBe(
      true,
    );
    expect(isControlSocketRemoved({ isListening: () => true }, "/s.sock", fsWith(true))).toBe(
      false,
    );
  });
});
