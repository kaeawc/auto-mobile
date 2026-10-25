import { afterEach, describe, expect, test } from "bun:test";
import { getDevicePoolTimeoutMs } from "../../src/daemon/poolConfig";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { getSessionIdleTimeoutMs } from "../../src/daemon/wire/sessionLivenessWindows";
import {
  getDefaultPreFirstHeartbeatGraceMs,
  getDefaultSessionHeartbeatTimeoutMs,
  SessionManager,
} from "../../src/daemon/sessionManager";

// #11612: the session, heartbeat and pool duration env reads share one strict integer parser, so a
// unit suffix is ignored (with a warning) instead of being read as its numeric prefix.
const READERS = [
  {
    name: "heartbeat timeout",
    env: "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
    alias: "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
    read: getDefaultSessionHeartbeatTimeoutMs,
    fallback: SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS,
    scale: 1,
  },
  {
    name: "pre-first-heartbeat grace",
    env: "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
    alias: "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
    read: getDefaultPreFirstHeartbeatGraceMs,
    fallback: getDefaultPreFirstHeartbeatGraceMs(),
    scale: 1,
  },
  {
    name: "device pool timeout (seconds)",
    env: "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
    alias: "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
    read: getDevicePoolTimeoutMs,
    fallback: 60_000,
    scale: 1000,
  },
];

const saved = new Map<string, string | undefined>();
for (const reader of READERS) {
  saved.set(reader.env, process.env[reader.env]);
  saved.set(reader.alias, process.env[reader.alias]);
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe.each(READERS)("$name env", ({ env, alias, read, fallback, scale }) => {
  test.each([["2m"], ["120s"], ["1e5"], ["5min"], ["1.5"], ["-3"], ["0"]])(
    "%j is ignored, not read as its numeric prefix",
    (value) => {
      delete process.env[alias];
      process.env[env] = value;
      expect(read()).toBe(fallback);
    },
  );

  test("a plain integer is honoured through either name", () => {
    delete process.env[alias];
    process.env[env] = "4321";
    expect(read()).toBe(4321 * scale);
    delete process.env[env];
    process.env[alias] = "4321";
    expect(read()).toBe(4321 * scale);
  });
});

describe("session idle timeout env (already strict, now warns)", () => {
  test("a unit suffix keeps the 2-minute default", () => {
    expect(getSessionIdleTimeoutMs({ AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS: "2m" })).toBe(120_000);
    expect(getSessionIdleTimeoutMs({ AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS: "45000" })).toBe(45_000);
  });
});

describe("heartbeat monitor check interval env", () => {
  const INTERVAL_ENV = "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS";
  const before = process.env[INTERVAL_ENV];

  afterEach(() => {
    if (before === undefined) {
      delete process.env[INTERVAL_ENV];
    } else {
      process.env[INTERVAL_ENV] = before;
    }
  });

  const intervalFor = (value: string): number => {
    process.env[INTERVAL_ENV] = value;
    const timer = new FakeTimer();
    const monitor = new SessionHeartbeatMonitor(
      new SessionManager(timer, new FakeDeviceSessionPersistence()),
      () => false,
      async () => {},
      timer,
    );
    monitor.start();
    const [period] = timer.getPendingIntervals().slice(-1);
    void monitor.stop();
    return period;
  };

  test("a unit suffix keeps the default scan period instead of a 1 ms busy loop", () => {
    expect(intervalFor("1m")).toBe(intervalFor("not-a-number"));
    expect(intervalFor("1m")).toBeGreaterThan(1);
    expect(intervalFor("250")).toBe(250);
  });
});
