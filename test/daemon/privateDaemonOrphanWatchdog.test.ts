import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PRIVATE_DAEMON_ORPHAN_IDLE_MS,
  PrivateDaemonOrphanWatchdog,
  isHarnessPrivateDaemon,
  resolvePrivateDaemonOrphanIdleMs,
  type PrivateDaemonOrphanPort,
} from "../../src/daemon/privateDaemonOrphanWatchdog";
import { FakeTimer } from "../fakes/FakeTimer";

const IDLE_MS = 10 * 60_000;

class FakeOrphanPort implements PrivateDaemonOrphanPort {
  ppid = 1;
  clients = 0;
  sessions = 0;
  shutdowns: string[] = [];
  parentPid(): number {
    return this.ppid;
  }
  clientCount(): number {
    return this.clients;
  }
  liveSessionCount(): number {
    return this.sessions;
  }
  shutdown(reason: string): void {
    this.shutdowns.push(reason);
  }
}

describe("PrivateDaemonOrphanWatchdog (#10497)", () => {
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

  test("checks on the injected timer once started", async () => {
    watchdog.start();
    await timer.advanceTimeAsync(IDLE_MS + 30_000);
    expect(port.shutdowns).toHaveLength(1);
    watchdog.stop();
  });

  test("arms only for harness-style private daemons, never a custom long-lived socket", () => {
    const defaultSocket = "/tmp/auto-mobile-daemon-501.sock";
    const harnessEnv = { AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/priv/aux" };
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
  });

  test("a zero idle timeout disables the watchdog", async () => {
    const disabled = new PrivateDaemonOrphanWatchdog(port, 0, timer);
    disabled.start();
    await timer.advanceTimeAsync(IDLE_MS * 10);
    expect(port.shutdowns).toEqual([]);
  });
});
