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
import type { PidFileData } from "../../src/daemon/types";
import { ActionableError } from "../../src/models/ActionableError";
import {
  daemonHttpAuthHeaders,
  FileDaemonHttpTokenStore,
  isDaemonHttpEndpoint,
  readDaemonPidFilePort,
  generateDaemonHttpToken,
  readDaemonHttpToken,
  verifyBearerToken,
} from "../../src/daemon/daemonHttpToken";

const endpointVectors: { url: string; daemon: boolean; discoveredPort: number | null }[] =
  JSON.parse(
    readFileSync(new URL("../fixtures/daemon-http-endpoints.json", import.meta.url), "utf8"),
  );
import type { DaemonHttpTokenRemovalFiles } from "../../src/daemon/daemonHttpToken";

const TOKEN = "private-test-token";

describe("daemon HTTP token helpers", () => {
  test.each(endpointVectors)(
    "scopes credentials to shared endpoint vector $url (pid-file port $discoveredPort)",
    ({ url, daemon, discoveredPort }) => {
      const env = { AUTOMOBILE_DAEMON_HTTP_TOKEN: TOKEN };
      const discoverPort = () => discoveredPort;
      expect(isDaemonHttpEndpoint(url, discoveredPort)).toBe(daemon);
      expect(daemonHttpAuthHeaders(url, env, {}, discoverPort)).toEqual(
        daemon ? { Authorization: `Bearer ${TOKEN}` } : {},
      );
      expect(
        daemonHttpAuthHeaders(
          url,
          env,
          { aUtHoRiZaTiOn: "caller", Accept: "application/json" },
          discoverPort,
        ),
      ).toEqual({
        aUtHoRiZaTiOn: "caller",
        Accept: "application/json",
      });
    },
  );

  test.each(endpointVectors)(
    "URL-object input requires original authority spelling: $url",
    ({ url, discoveredPort }) => {
      expect(
        daemonHttpAuthHeaders(
          new URL(url),
          { AUTOMOBILE_DAEMON_HTTP_TOKEN: TOKEN },
          {},
          () => discoveredPort,
        ),
      ).toEqual({});
    },
  );

  test("re-resolves the discovered port per request, so a restarted daemon is followed", () => {
    const env = { AUTOMOBILE_DAEMON_HTTP_TOKEN: TOKEN };
    let port: number | null = 3161;
    const url = "http://localhost:3162/heartbeat";
    expect(daemonHttpAuthHeaders(url, env, {}, () => port)).toEqual({});
    port = 3162;
    expect(daemonHttpAuthHeaders(url, env, {}, () => port)).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  test("does not consult the pid file for endpoints that are not daemon routes", () => {
    const discoverPort = () => {
      throw new Error("must not be called");
    };
    expect(
      daemonHttpAuthHeaders(
        "http://localhost:8080/other",
        { AUTOMOBILE_DAEMON_HTTP_TOKEN: TOKEN },
        {},
        discoverPort,
      ),
    ).toEqual({});
  });

  test.each([
    ["a valid port", { port: 3161 }, 3161],
    ["no pid file", null, null],
    ["a missing port", { pid: 1 }, null],
    ["a zero port", { port: 0 }, null],
    ["an out-of-range port", { port: 70000 }, null],
    ["a fractional port", { port: 3161.5 }, null],
    ["a string port", { port: "3161" }, null],
  ])("the default pid-file port reader returns the explicit port for %s", (_, data, expected) => {
    const seen: string[] = [];
    const port = readDaemonPidFilePort(
      { AUTOMOBILE_DAEMON_PID_FILE_PATH: "/isolated/daemon.pid" },
      (path) => {
        seen.push(path);
        return data as PidFileData | null;
      },
    );
    expect(port).toBe(expected);
    expect(seen).toEqual(["/isolated/daemon.pid"]);
  });

  test("the default pid-file port reader treats a throwing read as no port", () => {
    expect(
      readDaemonPidFilePort({}, () => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });

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
    expect(
      daemonHttpAuthHeaders("http://localhost:3161/auto-mobile/streamable", env, {}, () => 3161),
    ).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
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

  test("does not overwrite a token another daemon published during the Windows backoff", () => {
    const other = new FileDaemonHttpTokenStore(path, new CountingIdGenerator("other"));
    other.write("other-daemon-token");
    const sleeps: number[] = [];
    let attempts = 0;
    const retrying = new FileDaemonHttpTokenStore(path, new CountingIdGenerator("temporary"), {
      platform: "win32",
      renameFile: (source, destination) => {
        attempts++;
        if (attempts === 1) {
          throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
        }
        renameSync(source, destination);
      },
      sleep: (ms) => {
        sleeps.push(ms);
        // A concurrent daemon replaces the token while this one is backing off.
        rmSync(path);
        new FileDaemonHttpTokenStore(path, new CountingIdGenerator("racing")).write(
          "racing-daemon-token",
        );
      },
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(() => retrying.write(TOKEN)).toThrow(ActionableError);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([10]);
    expect(readFileSync(path, "utf8")).toBe("racing-daemon-token");
    expect(readdirSync(directory)).toEqual(["daemon.token"]);
    // The aborted store never claimed ownership, so remove() cannot delete the other token.
    retrying.remove();
    expect(readFileSync(path, "utf8")).toBe("racing-daemon-token");
  });

  test("does not claim a token published after the destination was observed absent", () => {
    let attempts = 0;
    const retrying = new FileDaemonHttpTokenStore(path, new CountingIdGenerator("temporary"), {
      platform: "win32",
      renameFile: () => {
        attempts++;
        throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      },
      sleep: () => {
        new FileDaemonHttpTokenStore(path, new CountingIdGenerator("racing")).write(
          "racing-daemon-token",
        );
      },
    });
    expect(() => retrying.write(TOKEN)).toThrow(ActionableError);
    expect(attempts).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("racing-daemon-token");
    retrying.remove();
    expect(readFileSync(path, "utf8")).toBe("racing-daemon-token");
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

  test("removal leaves a directory replacement in place without logging the token", () => {
    store.write(TOKEN);
    rmSync(path);
    mkdirSync(path);
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      store.remove();
      expect(statSync(path).isDirectory()).toBe(true);
      expect(readdirSync(directory)).toEqual(["daemon.token"]);
      expect(JSON.stringify(debug.mock.calls)).not.toContain(TOKEN);
    } finally {
      debug.mockRestore();
    }
  });

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
    expect(
      daemonHttpAuthHeaders("http://localhost:3161/auto-mobile/streamable", env, {}, () => 3161),
    ).toEqual({});
    store.write(` ${TOKEN}\n`);
    expect(readDaemonHttpToken(env)).toBe(TOKEN);
    expect(
      daemonHttpAuthHeaders("http://localhost:3161/auto-mobile/streamable", env, {}, () => 3161),
    ).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
    store.remove();
    expect(existsSync(path)).toBe(false);
    expect(store.read()).toBeUndefined();
    store.remove();
  });
});

/** The removal seam controls publication at each filesystem operation without scheduling or sockets. */
class RemovalFiles implements DaemonHttpTokenRemovalFiles {
  files = new Map<string, string>();
  beforeMove: () => void = () => {};
  afterMove: () => void = () => {};
  beforeRestore: () => void = () => {};
  restoreCalls = 0;
  entries: string[] = [];
  metadata = new Map<
    string,
    { directory?: boolean; symlink?: boolean; uid?: number; mode?: number; mtimeMs?: number }
  >();
  removedDirectories: string[] = [];
  list(_path: string): string[] {
    return this.entries;
  }
  inspect(path: string) {
    const entry = this.metadata.get(path) ?? {};
    return {
      isFile: () => !entry.directory && !entry.symlink,
      isDirectory: () => !!entry.directory,
      isSymbolicLink: () => !!entry.symlink,
      uid: entry.uid ?? process.getuid?.() ?? 0,
      mode: entry.mode ?? 0o700,
      mtimeMs: entry.mtimeMs ?? 0,
    };
  }
  createDirectory(prefix: string): string {
    return `${prefix}Ab12Cd`;
  }
  move(source: string, destination: string): void {
    this.beforeMove();
    const token = this.files.get(source);
    if (token === undefined) {
      throw new Error("Missing file");
    }
    this.files.set(destination, token);
    this.files.delete(source);
    this.afterMove();
  }
  read(path: string): string | undefined {
    return this.files.get(path);
  }
  restore(source: string, destination: string): void {
    this.restoreCalls++;
    this.beforeRestore();
    if (this.files.has(destination)) {
      throw new Error("Destination exists");
    }
    const token = this.files.get(source);
    if (token === undefined) {
      throw new Error("Missing file");
    }
    this.files.set(destination, token);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  removeDirectory(path: string): void {
    this.removedDirectories.push(path);
  }
}

describe("atomic token removal", () => {
  const scratch = useScratchRoot("am-token-remove-");
  const now = 120_000;

  test("a successor sweep preserves a fresh claim until the old daemon restores its token", () => {
    const path = join(scratch.next(), "daemon.token");
    const claim = `${path}.remove-Ab12Cd`;
    const files = new RemovalFiles();
    const store = new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), {
      removalFiles: files,
    });
    store.write(TOKEN);
    const move = files.move.bind(files);
    const successor = new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), {
      removalFiles: files,
      now: () => now,
      renameFile: (temporary, publicPath) => {
        // Publish B into the fake filesystem, then let A claim it before B's sweep.
        files.files.set(publicPath, readFileSync(temporary, "utf8"));
        rmSync(temporary);
        move(publicPath, `${claim}/token`);
      },
    });
    files.entries = ["daemon.token.remove-Ab12Cd"];
    files.metadata.set(claim, { directory: true, mtimeMs: now });
    // Pause A's move while B publishes; resume A's read/restore after B's sweep.
    files.move = () => successor.write("successor");

    store.remove();

    expect(files.restoreCalls).toBe(1);
    expect(files.read(path)).toBe("successor");
    expect(files.removedDirectories).toEqual([claim]);
  });

  test.each([
    { mtimeMs: now - 60_001, swept: true },
    { mtimeMs: now - 60_000, swept: false },
    { mtimeMs: now, swept: false },
    { mtimeMs: now + 1, swept: false },
    { mtimeMs: Number.NaN, swept: false },
    { mtimeMs: Number.NEGATIVE_INFINITY, swept: false },
  ])("sweeps only claims older than the age floor ($mtimeMs)", ({ mtimeMs, swept }) => {
    const path = join(scratch.next(), "daemon.token");
    const claim = `${path}.remove-Ab12Cd`;
    const files = new RemovalFiles();
    files.entries = ["daemon.token.remove-Ab12Cd"];
    files.metadata.set(claim, { directory: true, mtimeMs });
    files.files.set(`${claim}/token`, "stale");

    new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), {
      removalFiles: files,
      now: () => now,
    }).write(TOKEN);

    expect(files.removedDirectories).toEqual(swept ? [claim] : []);
    expect(files.read(`${claim}/token`)).toBe(swept ? undefined : "stale");
  });

  test.each(["win32", "linux"] as const)(
    "%s applies platform-appropriate ownership checks to stale claims",
    (platform) => {
      const path = join(scratch.next(), "daemon.token");
      const claim = `${path}.remove-Ab12Cd`;
      const files = new RemovalFiles();
      files.entries = ["daemon.token.remove-Ab12Cd"];
      files.metadata.set(claim, { directory: true, uid: -1, mode: 0o666 });

      new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), {
        removalFiles: files,
        platform,
        now: () => now,
      }).write(TOKEN);

      expect(files.removedDirectories).toEqual(platform === "win32" ? [claim] : []);
    },
  );

  test("POSIX cannot sweep a root-owned claim when getuid is unavailable", () => {
    const path = join(scratch.next(), "daemon.token");
    const files = new RemovalFiles();
    files.entries = ["daemon.token.remove-Ab12Cd"];
    files.metadata.set(`${path}.remove-Ab12Cd`, { directory: true, uid: 0 });
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), {
        removalFiles: files,
        platform: "linux",
        now: () => now,
      }).write(TOKEN);
      expect(files.removedDirectories).toEqual([]);
    } finally {
      if (getuid) {
        Object.defineProperty(process, "getuid", getuid);
      } else {
        Reflect.deleteProperty(process, "getuid");
      }
    }
  });

  test("publication sweeps private crash claims through the filesystem seam", () => {
    const parent = scratch.next();
    const path = join(parent, "daemon.token");
    const files = new RemovalFiles();
    files.entries = [
      "daemon.token.remove-Ab12Cd",
      "daemon.token.remove-Ab12Ce",
      "daemon.token.remove-Ab12Cf",
      "daemon.token.remove-Ab12Cg",
      "daemon.token.remove-invalid",
      "other.remove-Ab12Cd",
    ];
    for (const name of files.entries) {
      const directory = join(parent, name);
      files.metadata.set(directory, { directory: true });
      files.files.set(`${directory}/token`, "stale");
    }
    files.metadata.set(join(parent, files.entries[1]!), { directory: true, symlink: true });
    files.metadata.set(join(parent, files.entries[2]!), { directory: true, mode: 0o755 });
    files.metadata.set(join(parent, files.entries[3]!), { directory: true, uid: -1 });
    new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), { removalFiles: files }).write(
      TOKEN,
    );
    const swept = process.platform === "win32" ? [0, 2, 3] : [0];
    expect(files.removedDirectories).toEqual(
      swept.map((index) => join(parent, files.entries[index]!)),
    );
    expect(files.files.has(`${parent}/${files.entries[0]}/token`)).toBe(false);
    expect(files.files.size).toBe(files.entries.length - swept.length);
  });

  test("a restore failure without a newer publication also discards the claim", () => {
    const path = join(scratch.next(), "daemon.token");
    const files = new RemovalFiles();
    const store = new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), {
      removalFiles: files,
    });
    store.write(TOKEN);
    files.files.set(path, "successor");
    files.beforeRestore = () => {
      throw new Error("Hard links unavailable");
    };
    store.remove();
    expect(files.files.size).toBe(0);
    expect(files.removedDirectories).toHaveLength(1);
  });

  test("a claimed symlink is removed without restoring it", () => {
    const path = join(scratch.next(), "daemon.token");
    const files = new RemovalFiles();
    const store = new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), {
      removalFiles: files,
    });
    store.write(TOKEN);
    files.files.set(path, "successor");
    files.afterMove = () => {
      files.metadata.set(`${path}.remove-Ab12Cd/token`, { symlink: true });
    };
    store.remove();
    expect(files.restoreCalls).toBe(0);
    expect(files.files.size).toBe(0);
    expect(files.removedDirectories).toHaveLength(1);
  });

  test.each(["before move", "after move", "before restore"])(
    "preserves successor publication %s",
    (step) => {
      const path = join(scratch.next(), "daemon.token");
      const files = new RemovalFiles();
      const store = new FileDaemonHttpTokenStore(path, new CountingIdGenerator(), {
        removalFiles: files,
      });
      store.write(TOKEN);
      files.files.set(path, TOKEN);
      if (step === "before move") {
        files.beforeMove = () => {
          files.files.set(path, "successor");
        };
      }
      if (step === "after move") {
        files.afterMove = () => {
          files.files.set(path, "successor");
        };
      }
      if (step === "before restore") {
        files.beforeMove = () => {
          files.files.set(path, "successor");
        };
        files.beforeRestore = () => {
          files.files.set(path, "newest");
        };
      }
      store.remove();
      expect(files.files.get(path)).toBe(step === "before restore" ? "newest" : "successor");
      expect(files.files.size).toBe(1);
      expect(files.removedDirectories).toHaveLength(1);
    },
  );
});
