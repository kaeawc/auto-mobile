import { afterEach, describe, expect, test } from "bun:test";
import { resolveEnvTimeoutFloorMs } from "../../src/daemon/mcpRequestTimeout";
import { resolveMigrationLockTimeoutMs } from "../../src/db/migrationLock";
import {
  DEFAULT_NAV_RETENTION_INTERVAL_MS,
  resolveNavigationRetentionIntervalMs,
} from "../../src/db/navigationRetention";
import { resolveDoctorExecTimeoutMs } from "../../src/utils/diagnosticTimeouts";
import {
  DEFAULT_MAX_OBSERVATION_AGE_MS,
  maxObservationAgeMs,
} from "../../src/features/observe/observationFreshness";
import { resolveSimulatorWindowTimeoutMs } from "../../src/features/webrtc/IosH264Source";
import {
  DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS,
  resolveCtrlProxyForwardLeaseIdleMs,
} from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { PortManager, computeConfiguredScanEnd } from "../../src/utils/PortManager";
import {
  resolveConnectionTimeoutMs,
  resolveDaemonStartupTimeoutMs,
  resolveExistingDaemonReachabilityTimeoutMs,
} from "../../src/daemon/wire/constants";
import { resolveWorkProfilePollIntervalMs } from "../../src/utils/WorkProfileMonitor";
import { DefaultIosTunnelClient } from "../../src/ctrlProxy/ios/IosTunnelClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";

function iproxyStartTimeoutMs(env: NodeJS.ProcessEnv): number {
  return new DefaultIosTunnelClient({
    processExecutor: new FakeProcessExecutor(),
    timer: new FakeTimer(),
    remoteRunner: {
      startIproxy: async () => ({ success: true }),
      stopIproxy: async () => ({ success: true }),
      getIproxyStatus: async () => ({ success: true }),
    },
    useRemoteRunner: () => false,
    isRunning: async () => false,
    isConnected: async () => true,
    prepareRemoteStart: async () => {},
    getServicePort: () => 8765,
    getDeviceId: () => "usb-device",
    isStopping: () => false,
    isSimulator: () => false,
    restart: async () => {},
    env,
  }).getStartTimeoutMs();
}

// #11629: every numeric env read is a plain base-10 positive integer, else the default.
const GARBAGE = ["12abc", "2m", "30s", "1e3", "1.5", "0x10", "-5", "0", "+4", "abc"];
const BASE_PORT = 8765;

interface Case {
  name: string;
  env: string;
  /** What an unset variable reads as. */
  unset: number | undefined;
  /** What `" 12345 "` reads as. */
  valid: number | undefined;
  read: (env: NodeJS.ProcessEnv) => number | undefined;
}

const cases: Case[] = [
  {
    name: "observe MCP timeout floor",
    env: "AUTOMOBILE_OBSERVE_MCP_TIMEOUT_MS",
    unset: 90_000,
    valid: 12345,
    read: (env) =>
      resolveEnvTimeoutFloorMs(
        "AUTOMOBILE_OBSERVE_MCP_TIMEOUT_MS",
        "AUTO_MOBILE_OBSERVE_MCP_TIMEOUT_MS",
        90_000,
        env,
      ),
  },
  {
    name: "migration lock timeout",
    env: "AUTOMOBILE_MIGRATION_LOCK_TIMEOUT_MS",
    unset: undefined,
    valid: 12345,
    read: (env) => resolveMigrationLockTimeoutMs(env),
  },
  {
    name: "max observation age",
    env: "AUTOMOBILE_MAX_OBSERVATION_AGE_MS",
    unset: DEFAULT_MAX_OBSERVATION_AGE_MS,
    valid: 12345,
    read: () => maxObservationAgeMs(),
  },
  {
    name: "iOS simulator window timeout",
    env: "AUTOMOBILE_IOS_SIMULATOR_WINDOW_TIMEOUT_MS",
    unset: 2_000,
    valid: 12345,
    read: (env) => resolveSimulatorWindowTimeoutMs(env),
  },
  {
    name: "navigation retention interval",
    env: "AUTOMOBILE_NAV_RETENTION_INTERVAL_MS",
    unset: DEFAULT_NAV_RETENTION_INTERVAL_MS,
    valid: 12345,
    read: () => resolveNavigationRetentionIntervalMs(),
  },
  {
    name: "port range start",
    env: "AUTOMOBILE_PORT_RANGE_START",
    unset: BASE_PORT,
    valid: 12345,
    read: (env) => PortManager.resolveBasePort(env),
  },
  {
    name: "port range size",
    env: "AUTOMOBILE_PORT_RANGE_SIZE",
    unset: PortManager.resolveMaxDevices({}, BASE_PORT),
    valid: 12345,
    read: (env) => PortManager.resolveMaxDevices(env, BASE_PORT),
  },
  {
    name: "port range end",
    env: "AUTOMOBILE_PORT_RANGE_END",
    unset: PortManager.resolveMaxDevices({}, BASE_PORT),
    valid: 12345 - BASE_PORT + 1,
    read: (env) => PortManager.resolveMaxDevices(env, BASE_PORT),
  },
  {
    name: "ctrl proxy health max attempts",
    env: "AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS",
    unset: IOSCtrlProxyManager.resolveHealthPollMaxAttempts({}),
    valid: 12345,
    read: (env) => IOSCtrlProxyManager.resolveHealthPollMaxAttempts(env),
  },
  {
    name: "doctor exec timeout",
    env: "AUTOMOBILE_DOCTOR_TIMEOUT_MS",
    unset: 5000,
    valid: 12345,
    read: (env) => resolveDoctorExecTimeoutMs(env),
  },
  {
    name: "ctrl proxy forward lease idle",
    env: "AUTOMOBILE_CTRL_PROXY_LEASE_IDLE_MS",
    unset: DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS,
    valid: 12345,
    read: (env) => resolveCtrlProxyForwardLeaseIdleMs(env),
  },
  {
    name: "daemon connection timeout",
    env: "AUTOMOBILE_DAEMON_TIMEOUT_MS",
    unset: 120_000,
    valid: 12345,
    read: (env) => resolveConnectionTimeoutMs(env),
  },
  {
    name: "daemon connection timeout (legacy alias)",
    env: "AUTO_MOBILE_DAEMON_TIMEOUT_MS",
    unset: 120_000,
    valid: 12345,
    read: (env) => resolveConnectionTimeoutMs(env),
  },
  {
    name: "daemon startup timeout",
    env: "AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS",
    unset: 30_000,
    valid: 12345,
    read: (env) => resolveDaemonStartupTimeoutMs(env),
  },
  {
    name: "existing daemon reachability timeout",
    env: "AUTOMOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS",
    unset: 10_000,
    valid: 12345,
    read: (env) => resolveExistingDaemonReachabilityTimeoutMs(30_000, env),
  },
  {
    name: "work profile poll interval",
    env: "AUTOMOBILE_WORK_PROFILE_POLL_INTERVAL_MS",
    unset: 5000,
    valid: 12345,
    read: (env) => resolveWorkProfilePollIntervalMs(undefined, env),
  },
  {
    name: "iproxy start timeout",
    env: "AUTOMOBILE_IPROXY_START_TIMEOUT_MS",
    unset: 5000,
    valid: 12345,
    read: (env) => iproxyStartTimeoutMs(env),
  },
  {
    name: "iproxy start timeout (legacy alias)",
    env: "AUTO_MOBILE_IPROXY_START_TIMEOUT_MS",
    unset: 5000,
    valid: 12345,
    read: (env) => iproxyStartTimeoutMs(env),
  },
];

// Some readers consult process.env directly: set it, and restore afterwards.
const saved = new Map<string, string | undefined>();
function readWith(env: string, raw: string | undefined, read: Case["read"]): number | undefined {
  if (!saved.has(env)) {
    saved.set(env, process.env[env]);
  }
  if (raw === undefined) {
    delete process.env[env];
  } else {
    process.env[env] = raw;
  }
  return read(raw === undefined ? {} : { [env]: raw });
}

afterEach(() => {
  for (const [name, original] of saved) {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
  saved.clear();
});

describe("strict positive-integer env reads (#11629)", () => {
  test("an explicit work profile poll interval wins over the environment", () => {
    expect(
      resolveWorkProfilePollIntervalMs(250, { AUTOMOBILE_WORK_PROFILE_POLL_INTERVAL_MS: "9000" }),
    ).toBe(250);
  });

  test("the daemon startup timeout is still clamped to the timer ceiling", () => {
    expect(
      resolveDaemonStartupTimeoutMs({ AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS: "99999999999" }),
    ).toBe(2_147_483_647);
  });

  test("the reachability timeout stays under two-thirds of the startup budget", () => {
    expect(
      resolveExistingDaemonReachabilityTimeoutMs(30_000, {
        AUTOMOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS: "60000",
      }),
    ).toBe(20_000);
  });

  describe.each(cases)("$name ($env)", ({ env, unset, valid, read }) => {
    test("unset is the default", () => {
      expect(readWith(env, undefined, read)).toBe(unset);
    });

    test.each(GARBAGE)("%j is ignored in favour of the default", (raw) => {
      expect(readWith(env, raw, read)).toBe(unset);
    });

    test("empty and whitespace-only are the default", () => {
      expect(readWith(env, "", read)).toBe(unset);
      expect(readWith(env, "   ", read)).toBe(unset);
    });

    test("a plain integer, trimmed, is used", () => {
      expect(readWith(env, " 12345 ", read)).toBe(valid);
    });
  });

  test("the scan-end computation rejects the same garbage", () => {
    expect(computeConfiguredScanEnd(BASE_PORT, "8800", undefined)).toBe(8800);
    expect(computeConfiguredScanEnd(BASE_PORT, "8800abc", undefined)).toBeUndefined();
    expect(computeConfiguredScanEnd(BASE_PORT, undefined, "5")).toBe(8769);
    expect(computeConfiguredScanEnd(BASE_PORT, undefined, "5x")).toBeUndefined();
    expect(computeConfiguredScanEnd(BASE_PORT, undefined, "1e2")).toBeUndefined();
  });
});
