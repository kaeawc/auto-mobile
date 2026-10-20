import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeDaemonShutdownIo } from "../helpers/daemonShutdownIoFakes";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { useScratchRoot } from "../helpers/scratchRoot";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { logger } from "../../src/utils/logger";
import { ActionableError } from "../../src/models/ActionableError";
import {
  daemonHttpAuthHeaders,
  FileDaemonHttpTokenStore,
  generateDaemonHttpToken,
  readDaemonHttpToken,
  verifyBearerToken,
} from "../../src/daemon/daemonHttpToken";

const TOKEN = "private-test-token";

describe("daemon HTTP token helpers", () => {
  test("uses the injected identifier deterministically", () => {
    const ids = new CountingIdGenerator("uuid");
    expect(generateDaemonHttpToken(ids)).toBe("uuid-1");
    expect(ids.next()).toBe("uuid-2");
  });

  test("the production default generates 32 bytes encoded as base64url", () => {
    const token = generateDaemonHttpToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  test.each([
    [`Bearer ${TOKEN}`, TOKEN, true],
    ["Bearer different", TOKEN, false],
    ["Bearer x", TOKEN, false],
    [`Bearer ${"x".repeat(200)}`, TOKEN, false],
    ["Bearer ", TOKEN, false],
    [undefined, TOKEN, false],
    [`Basic ${TOKEN}`, TOKEN, false],
    [`bearer ${TOKEN}`, TOKEN, true],
    [`bEaReR ${TOKEN}`, TOKEN, true],
    [`BEARER ${TOKEN}`, TOKEN, true],
    [`BearerX ${TOKEN}`, TOKEN, false],
    [`Bearer ${TOKEN} `, TOKEN, false],
    ["Bearer ", "", false],
  ] as const)(
    "verifies equal, unequal and different-length credentials (%#)",
    (header, expected, valid) => {
      expect(verifyBearerToken(header, expected)).toBe(valid);
    },
  );

  test("the client env override takes precedence without reading a file", () => {
    const env = {
      AUTOMOBILE_DAEMON_HTTP_TOKEN: `  ${TOKEN}  `,
      AUTOMOBILE_DAEMON_TOKEN_FILE_PATH: "/unused/token",
    };
    expect(readDaemonHttpToken(env)).toBe(TOKEN);
    expect(daemonHttpAuthHeaders(env)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });
});

describe("daemon HTTP token runtime file", () => {
  const scratch = useScratchRoot("am-token-store-");
  let directory: string;
  let path: string;
  let store: FileDaemonHttpTokenStore;
  beforeEach(() => {
    directory = scratch.next();
    path = join(directory, "daemon.token");
    store = new FileDaemonHttpTokenStore(path, new CountingIdGenerator("temporary"));
  });

  test("publishes only the token with mode 0600 and leaves no temporary file", () => {
    store.write(TOKEN);
    expect(readFileSync(path, "utf8")).toBe(TOKEN);
    expect(readdirSync(directory)).toEqual(["daemon.token"]);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o7777).toBe(0o600);
      expect(process.getuid?.()).toBe(statSync(path).uid);
    }
    expect(store.read()).toBe(TOKEN);
  });

  test("creates a missing parent directory with owner-only mode where supported", () => {
    const parent = join(directory, "auto-mobile");
    const nested = new FileDaemonHttpTokenStore(join(parent, "daemon.token"));
    nested.write(TOKEN);
    expect(nested.read()).toBe(TOKEN);
    if (process.platform !== "win32") {
      expect(statSync(parent).mode & 0o777).toBe(0o700);
    }
  });

  test("removal preserves another daemon's token and an unpublished reader cannot delete it", () => {
    store.write(TOKEN);
    const other = new FileDaemonHttpTokenStore(path);
    other.remove();
    expect(store.read()).toBe(TOKEN);
    other.write("other-daemon");
    store.remove();
    expect(other.read()).toBe("other-daemon");
    other.remove();
    expect(existsSync(path)).toBe(false);
  });

  test("removal tolerates an already-absent published file", () => {
    store.write(TOKEN);
    rmSync(path);
    expect(() => store.remove()).not.toThrow();
    expect(store.read()).toBeUndefined();
  });

  test("replaces a stale file after its reader closes", () => {
    writeFileSync(path, "stale");
    const fd = openSync(path, "r");
    try {
      expect(readFileSync(fd, "utf8")).toBe("stale");
    } finally {
      closeSync(fd);
    }
    store.write(TOKEN);
    expect(store.read()).toBe(TOKEN);
    expect(readdirSync(directory)).toEqual(["daemon.token"]);
  });

  test.each(["EPERM", "EBUSY", "EACCES"])(
    "retries transient %s on Windows with synchronous backoff",
    (code) => {
      writeFileSync(path, "stale");
      const sleeps: number[] = [];
      let attempts = 0;
      const retrying = new FileDaemonHttpTokenStore(path, new CountingIdGenerator("temporary"), {
        platform: "win32",
        sleep: (ms) => {
          sleeps.push(ms);
        },
        renameFile: (source, destination) => {
          expect(readFileSync(source, "utf8")).toBe(TOKEN);
          if (process.platform !== "win32") {
            expect(statSync(source).mode & 0o7777).toBe(0o600);
          }
          if (++attempts <= 2) {
            throw Object.assign(new Error("sharing violation"), { code });
          }
          renameSync(source, destination);
        },
      });
      retrying.write(TOKEN);
      expect(attempts).toBe(3);
      expect(sleeps).toEqual([10, 20]);
      expect(retrying.read()).toBe(TOKEN);
      expect(readdirSync(directory)).toEqual(["daemon.token"]);
      retrying.remove();
      expect(existsSync(path)).toBe(false);
    },
  );

  test.each([
    ["win32", "EPERM", 5, [10, 20, 40, 80]],
    ["darwin", "EPERM", 1, []],
    ["win32", "ENOENT", 1, []],
  ] as const)(
    "bounds rename failure on %s for %s",
    (platform, code, expectedAttempts, expectedSleeps) => {
      writeFileSync(path, "stale");
      const sleeps: number[] = [];
      let attempts = 0;
      const failing = new FileDaemonHttpTokenStore(path, new CountingIdGenerator("temporary"), {
        platform,
        sleep: (ms) => {
          sleeps.push(ms);
        },
        renameFile: () => {
          attempts++;
          throw Object.assign(new Error("rename failed"), { code });
        },
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(() => failing.write(TOKEN)).toThrow(ActionableError);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
      } finally {
        warn.mockRestore();
      }
      expect(attempts).toBe(expectedAttempts);
      expect(sleeps).toEqual([...expectedSleeps]);
      expect(readFileSync(path, "utf8")).toBe("stale");
      expect(readdirSync(directory)).toEqual(["daemon.token"]);
      failing.remove();
      expect(readFileSync(path, "utf8")).toBe("stale");
    },
  );

  test("rechecks an unsafe target before retrying a Windows rename", () => {
    writeFileSync(path, "stale");
    let attempts = 0;
    const sleeps: number[] = [];
    const retrying = new FileDaemonHttpTokenStore(path, new CountingIdGenerator("temporary"), {
      platform: "win32",
      renameFile: () => {
        attempts++;
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      },
      sleep: (ms) => {
        sleeps.push(ms);
        rmSync(path);
        // A directory is unsafe on every platform, without requiring symlink privileges.
        mkdirSync(path);
      },
    });
    expect(() => retrying.write(TOKEN)).toThrow("Unable to persist daemon HTTP token");
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([10]);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(directory)).toEqual(["daemon.token"]);
  });

  test.skipIf(process.platform === "win32")(
    "atomically replaces a stale file, preserving an already-open reader",
    () => {
      writeFileSync(path, "stale");
      const fd = openSync(path, "r");
      try {
        store.write(TOKEN);
        expect(readFileSync(fd, "utf8")).toBe("stale");
        expect(store.read()).toBe(TOKEN);
        expect(readdirSync(directory)).toEqual(["daemon.token"]);
        if (process.platform !== "win32") {
          expect(statSync(path).mode & 0o7777).toBe(0o600);
        }
      } finally {
        closeSync(fd);
      }
    },
  );

  test("creates temporary files exclusively and preserves stale content on failure", () => {
    const collision = `${path}.temporary-1.tmp`;
    writeFileSync(path, "stale");
    writeFileSync(collision, "existing-temp");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(() => store.write(TOKEN)).toThrow("Unable to persist daemon HTTP token");
      expect(warn).toHaveBeenCalledWith("Unable to persist daemon HTTP token");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(collision, "utf8")).toBe("existing-temp");
    expect(readFileSync(path, "utf8")).toBe("stale");
  });

  test.skipIf(process.platform === "win32")(
    "refuses symlink targets for both reads and writes without disclosing credentials",
    () => {
      const target = join(directory, "target");
      writeFileSync(target, TOKEN, { mode: 0o600 });
      symlinkSync(target, path);
      const logs: unknown[] = [];
      const debug = spyOn(logger, "debug").mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
      try {
        expect(store.read()).toBeUndefined();
        expect(() => store.write(TOKEN)).toThrow("Unable to persist daemon HTTP token");
        expect(readFileSync(target, "utf8")).toBe(TOKEN);
        expect(JSON.stringify(logs)).not.toContain(TOKEN);
        expect(readdirSync(directory).sort()).toEqual(["daemon.token", "target"]);
      } finally {
        debug.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects non-0600 permissions and a different owner",
    () => {
      store.write(TOKEN);
      chmodSync(path, 0o644);
      expect(store.read()).toBeUndefined();
      chmodSync(path, 0o600);
      expect(store.read()).toBe(TOKEN);
      const uid = process.getuid?.() ?? 0;
      const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        expect(store.read()).toBeUndefined();
      } finally {
        getuid.mockRestore();
      }
    },
  );

  test("daemon startup publication overwrites stale content and clean shutdown removes the file", async () => {
    resetDbWriteBarrier();
    const restore = await fakeDaemonShutdownIo();
    try {
      store.write("stale-token");
      const daemon = new Daemon(
        {},
        {
          timer: new FakeTimer(),
          idGenerator: new CountingIdGenerator("daemon"),
          httpTokenStore: store,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceSessionRepository: new FakeDeviceSessionRepository(),
        },
      );
      daemon.testHooks.prepareHttpToken();
      expect(store.read()).toBe("stale-token");
      daemon.testHooks.publishHttpToken();
      expect(store.read()).toBe("daemon-2");
      await daemon.stop();
      expect(existsSync(path)).toBe(false);
      await expect(daemon.testHooks.httpIngress.start()).rejects.toThrow(
        "Daemon HTTP token is not configured",
      );
    } finally {
      restore();
      DaemonState.getInstance().reset();
      resetDbWriteBarrier();
    }
  });

  test("client helpers trim file content and treat missing or unsafe files as absent", () => {
    const env = { AUTOMOBILE_DAEMON_TOKEN_FILE_PATH: path };
    expect(readDaemonHttpToken(env)).toBeUndefined();
    expect(daemonHttpAuthHeaders(env)).toEqual({});
    store.write(` ${TOKEN}\n`);
    expect(readDaemonHttpToken(env)).toBe(TOKEN);
    expect(daemonHttpAuthHeaders(env)).toEqual({ Authorization: `Bearer ${TOKEN}` });
    store.remove();
    expect(existsSync(path)).toBe(false);
    expect(store.read()).toBeUndefined();
    store.remove();
  });
});
