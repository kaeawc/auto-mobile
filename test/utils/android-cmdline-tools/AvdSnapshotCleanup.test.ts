import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import type { BindingRegistryDatabase } from "../../../src/daemon/sessionBroker/registry/bindingRegistryRows";
import { SqliteAvdSnapshotCleanupRegistry } from "../../../src/daemon/sessionBroker/registry/avdSnapshotCleanupRegistry";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, lstat, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sortedReaddir } from "../../../src/utils/io";
import type { AvdDirectoryResolver } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import {
  cleanupAvdSnapshots,
  nodeAvdSnapshotCleanupFilesystem,
  planAvdSnapshotCleanup,
  type AvdSnapshotCleanupFilesystem,
  type AvdSnapshotCleanupRegistry,
  type AvdSnapshotCleanupLiveness,
} from "../../../src/daemon/sessionBroker/AvdSnapshotCleanup";

const baseline = "automobile-broker-baseline-v1";
class FakeRegistry implements AvdSnapshotCleanupRegistry {
  names: string[] = [];
  error = false;
  async listReferencedAvdNames() {
    if (this.error) {
      throw new Error("registry unavailable");
    }
    return this.names;
  }
}
class FakeLiveness implements AvdSnapshotCleanupLiveness {
  process = false;
  serial: string | null = null;
  error = false;
  calls = 0;
  async hasLiveProcess() {
    this.calls++;
    if (this.error) {
      throw new Error("process uncertain");
    }
    return this.process;
  }
  async findLiveEmulatorSerial() {
    return this.serial;
  }
}
class FakeResolver implements AvdDirectoryResolver {
  directory: string | null;
  constructor(
    readonly home: string,
    name: string,
  ) {
    this.directory = join(home, `${name}.avd`);
  }
  getAvdHome() {
    return this.home;
  }
  async resolveAvdDirectory() {
    return this.directory;
  }
}
class FakeFilesystem implements AvdSnapshotCleanupFilesystem {
  removed: string[] = [];
  names = ["capture", "default_boot", baseline];
  async listNames(path: string) {
    if (path.endsWith("snapshots")) {
      return this.names;
    }
    if (path.endsWith(".avd")) {
      return ["snapshots"];
    }
    return [
      "ambroker-stale.avd",
      "amslot-stale.avd",
      "amverify-old.avd",
      "user-avd.avd",
      "AMBROKER-stale.avd",
    ];
  }
  async realpath(path: string) {
    return resolve(path);
  }
  async lstat() {
    return { isDirectory: () => true, isSymbolicLink: () => false };
  }
  async removeDirectory(path: string) {
    this.removed.push(path);
  }
}
function fixture(name = "ambroker-stale") {
  const filesystem = new FakeFilesystem();
  const registry = new FakeRegistry();
  const liveness = new FakeLiveness();
  const resolver = new FakeResolver(resolve("scratch", "fake-avds"), name);
  const warnings: string[] = [];
  const ports = {
    filesystem,
    registry,
    liveness,
    resolver,
    log: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
  };
  return {
    name,
    filesystem,
    registry,
    liveness,
    resolver,
    warnings,
    ports,
    run: () => cleanupAvdSnapshots([name], ports),
  };
}

describe("stale broker snapshot cleanup", () => {
  for (const name of ["ambroker-stale", "amslot-stale"]) {
    test(`${name} removes capture and retains baseline and default_boot`, async () => {
      const f = fixture(name);
      const [report] = await f.run();
      expect(report.deletedSnapshotNames).toEqual(["capture"]);
      expect(report.keptSnapshots.map((entry) => entry.snapshotName)).toEqual([
        "default_boot",
        baseline,
      ]);
      expect(f.filesystem.removed).toEqual([join(f.resolver.directory!, "snapshots", "capture")]);
      expect(f.liveness.calls).toBe(2);
    });
  }
  test("any registry reference, including a case mismatch, retains everything", async () => {
    for (const reference of ["ambroker-stale", "AMBROKER-STALE"]) {
      const f = fixture();
      f.registry.names = [reference];
      expect((await f.run())[0].deletedSnapshotNames).toEqual([]);
      expect(f.filesystem.removed).toEqual([]);
    }
  });
  test("live process, live serial, and uncertain liveness retain everything", async () => {
    for (const mode of ["process", "serial", "error"]) {
      const f = fixture();
      f.liveness.process = mode === "process";
      f.liveness.serial = mode === "serial" ? "emulator-5554" : null;
      f.liveness.error = mode === "error";
      expect((await f.run())[0].deletedSnapshotNames).toEqual([]);
      expect(f.filesystem.removed).toEqual([]);
    }
  });
  test("registry failure or missing port retains the whole run", async () => {
    const f = fixture();
    f.registry.error = true;
    const reports = await cleanupAvdSnapshots([f.name, "amslot-old"], f.ports);
    expect(
      reports.every((report) => report.deletedSnapshotNames.length === 0 && report.error),
    ).toBe(true);
    expect(f.filesystem.removed).toEqual([]);
    expect(
      (await cleanupAvdSnapshots([f.name], { ...f.ports, registry: undefined }))[0].error,
    ).toBeDefined();
  });
  for (const name of ["amverify-old", "user-avd", "AMBROKER-stale"]) {
    test(`never deletes ${name}`, async () => {
      const f = fixture(name);
      await f.run();
      expect(f.filesystem.removed).toEqual([]);
    });
  }
  test("pure plan protects case aliases and respects validation evidence", () => {
    const plan = planAvdSnapshotCleanup({
      avdName: "ambroker-old",
      snapshotNames: ["../escape", "a\\b", "DEFAULT_BOOT", baseline.toUpperCase(), "capture"],
      referencedAvdNames: [],
      running: false,
      unsafeSnapshotReasons: new Map([
        ["../escape", "invalid segment"],
        ["a\\b", "invalid segment"],
      ]),
    });
    expect(plan.deleteNames).toEqual(["capture"]);
    expect(plan.keptSnapshots).toHaveLength(4);
  });
  test("invalid snapshot segments are kept by the executor", async () => {
    const f = fixture();
    f.filesystem.names = ["../escape", "a/b", "a\\b", "capture"];
    const [report] = await f.run();
    expect(report.deletedSnapshotNames).toEqual(["capture"]);
    expect(report.keptSnapshots).toHaveLength(3);
  });
  test("resolver null, redirect, and name case mismatch retain everything", async () => {
    for (const directory of [
      null,
      resolve("scratch", "elsewhere.avd"),
      resolve("scratch", "fake-avds", "AMBROKER-stale.avd"),
    ]) {
      const f = fixture();
      f.resolver.directory = directory;
      expect((await f.run())[0].error).toBeDefined();
      expect(f.filesystem.removed).toEqual([]);
    }
  });
  test("a serial lookup failure is not absence", async () => {
    const f = fixture();
    f.liveness.findLiveEmulatorSerial = async () => {
      throw new Error("adb unavailable");
    };
    expect((await f.run())[0].error).toContain("adb unavailable");
    expect(f.filesystem.removed).toEqual([]);
  });
  test("rechecks liveness before removal", async () => {
    const f = fixture();
    f.liveness.hasLiveProcess = async () => ++f.liveness.calls > 1;
    await f.run();
    expect(f.filesystem.removed).toEqual([]);
  });
  test("unreadable listings and failed removals produce typed errors and warnings", async () => {
    const f = fixture();
    f.filesystem.listNames = async () => {
      throw new Error("unreadable");
    };
    expect((await f.run())[0].error).toContain("unreadable");
    const g = fixture();
    g.filesystem.removeDirectory = async () => {
      throw new Error("permission denied");
    };
    const [report] = await g.run();
    expect(report.error).toContain("permission denied");
    expect(report.keptSnapshots.some((entry) => entry.snapshotName === "capture")).toBe(true);
    expect(g.warnings.length).toBeGreaterThan(0);
  });
});

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
const diskFilesystem = nodeAvdSnapshotCleanupFilesystem;

test("real temporary AVD tree deletes only stale capture directories", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "avd-cleanup-")));
  temporary.push(home);
  const f = fixture();
  f.resolver = new FakeResolver(home, f.name);
  const root = join(f.resolver.directory!, "snapshots");
  for (const name of ["capture", baseline, "default_boot"]) {
    await mkdir(join(root, name), { recursive: true });
  }
  const [report] = await cleanupAvdSnapshots([f.name], {
    ...f.ports,
    resolver: f.resolver,
    filesystem: diskFilesystem,
  });
  expect(report.deletedSnapshotNames).toEqual(["capture"]);
  expect(await sortedReaddir(root)).toEqual([baseline, "default_boot"]);
});
for (const linkAt of ["avd", "snapshots", "capture"]) {
  test(`does not follow a ${linkAt} symlink`, async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "avd-cleanup-link-")));
    temporary.push(home);
    const f = fixture();
    const resolver = new FakeResolver(home, f.name);
    const avd = resolver.directory!;
    const root = join(avd, "snapshots");
    const outside = join(home, "outside");
    await mkdir(outside);
    await mkdir(root, { recursive: true });
    const target = linkAt === "avd" ? avd : linkAt === "snapshots" ? root : join(root, "capture");
    await rm(target, { recursive: true, force: true });
    await symlink(outside, target, "junction");
    const [report] = await cleanupAvdSnapshots([f.name], {
      ...f.ports,
      resolver,
      filesystem: diskFilesystem,
    });
    expect(report.deletedSnapshotNames).toEqual([]);
    expect(report.error).toBeDefined();
    expect(await lstat(outside)).toBeDefined();
  });
}

test("canonical resolution outside snapshots root is kept", async () => {
  const f = fixture();
  f.filesystem.realpath = async (path) =>
    path.endsWith("capture") ? resolve("scratch", "outside") : resolve(path);
  const [report] = await f.run();
  expect(report.deletedSnapshotNames).toEqual([]);
  expect(report.error).toContain("Not an exact real directory");
  expect(f.filesystem.removed).toEqual([]);
});

test("a failed candidate keeps all remaining candidates on that AVD", async () => {
  const f = fixture();
  f.filesystem.names = ["first", "bad", "last"];
  f.filesystem.removeDirectory = async (path) => {
    if (path.endsWith("bad")) {
      throw new Error("removal failed");
    }
    f.filesystem.removed.push(path);
  };
  const [report] = await f.run();
  expect(report.deletedSnapshotNames).toEqual(["first"]);
  expect(report.keptSnapshots.map((entry) => entry.snapshotName)).toEqual(["bad", "last"]);
});

test("registry reader protects assignment and terminal journal references in every state", async () => {
  const sqlite = new Database(":memory:");
  const db = new Kysely<BindingRegistryDatabase>({
    dialect: new BunSqliteDialect({ database: sqlite }),
  });
  try {
    sqlite.exec(
      "CREATE TABLE slot_assignments (device_name TEXT, stable_device_id TEXT, state TEXT)",
    );
    sqlite.exec(
      "CREATE TABLE slot_journal (binding_stable_device_id TEXT, target_json TEXT, phase TEXT)",
    );
    for (const state of ["ready", "settling", "replacing", "failed"]) {
      sqlite
        .query("INSERT INTO slot_assignments VALUES (?, ?, ?)")
        .run(`ambroker-${state}`, `amslot-${state}`, state);
    }
    sqlite.query("INSERT INTO slot_journal VALUES (?, ?, ?)").run(
      "ambroker-binding",
      JSON.stringify({
        oldName: "ambroker-old",
        oldStableId: "amslot-old",
        newName: "ambroker-stale",
        newStableId: "amslot-new",
      }),
      "committed",
    );
    const registry = new SqliteAvdSnapshotCleanupRegistry(db);
    const names = await registry.listReferencedAvdNames();
    for (const state of ["ready", "settling", "replacing", "failed"]) {
      expect(names).toContain(`ambroker-${state}`);
      expect(names).toContain(`amslot-${state}`);
    }
    for (const name of [
      "ambroker-binding",
      "ambroker-old",
      "amslot-old",
      "ambroker-stale",
      "amslot-new",
    ]) {
      expect(names).toContain(name);
    }
    const f = fixture();
    expect(
      (await cleanupAvdSnapshots([f.name], { ...f.ports, registry }))[0].deletedSnapshotNames,
    ).toEqual([]);
    sqlite
      .query("INSERT INTO slot_journal VALUES (?, ?, ?)")
      .run(null, "invalid json", "rolled_back");
    expect((await cleanupAvdSnapshots([f.name], { ...f.ports, registry }))[0].error).toBeDefined();
    expect(f.filesystem.removed).toEqual([]);
  } finally {
    await db.destroy();
  }
});
