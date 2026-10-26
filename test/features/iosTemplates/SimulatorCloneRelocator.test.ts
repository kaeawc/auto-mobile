import { expect, test } from "bun:test";
import {
  CLONE_RELOCATION_SKIP_DIRS,
  SimulatorCloneRelocator,
  type CloneRelocationFileSystem,
  type CloneRelocationScan,
} from "../../../src/features/iosTemplates/SimulatorCloneRelocator";

const TEMPLATE = "E63A5A84-4C3D-4635-9BB6-9EEA7ABBDE77";
const CLONE = "3CC91698-300E-4A9D-AF3B-8F8424E1FBF1";
const ROOT = "/devices";
const DATA = `${ROOT}/${CLONE}/data`;

class Fixture {
  events: string[] = [];
  scan: CloneRelocationScan = { files: [], links: [] };
  existing = new Set<string>();
  withNeedleAfterCheckpoint = new Set<string>();
  failingCheckpoints = new Set<string>();
  fs: CloneRelocationFileSystem = {
    scan: async (root, needle, skipDirs) => {
      this.events.push(`scan:${root}:${needle}:${skipDirs.join(",")}`);
      return this.scan;
    },
    exists: async (path) => this.existing.has(path),
    fileContains: async (path) => this.withNeedleAfterCheckpoint.has(path),
    replaceInFile: async (path, from, to) => {
      this.events.push(`replace:${path}:${from}>${to}`);
    },
    retargetLink: async (path, from, to) => {
      this.events.push(`link:${path}:${from}>${to}`);
    },
  };
  relocator = new SimulatorCloneRelocator({
    fs: this.fs,
    deviceSetRoot: () => ROOT,
    checkpointer: {
      checkpoint: async (database) => {
        this.events.push(`checkpoint:${database}`);
        if (this.failingCheckpoints.has(database)) {
          throw new Error("database is locked");
        }
      },
    },
  });
}

test("scans the clone's data directory, skipping unified-log archives", async () => {
  const fixture = new Fixture();
  await fixture.relocator.relocate({ templateUdid: TEMPLATE, cloneUdid: CLONE });
  expect(fixture.events).toEqual([
    `scan:${DATA}:${TEMPLATE}:${CLONE_RELOCATION_SKIP_DIRS.join(",")}`,
  ]);
  expect(CLONE_RELOCATION_SKIP_DIRS).toEqual(["var/db/diagnostics"]);
});

test("rewrites each file and retargets each link from the template UDID to the clone UDID", async () => {
  const fixture = new Fixture();
  fixture.scan = {
    files: [`${DATA}/var/db/lsd/store.csstore`, `${DATA}/Library/Preferences/a.plist`],
    links: [`${DATA}/Library/Logs`],
  };
  const result = await fixture.relocator.relocate({ templateUdid: TEMPLATE, cloneUdid: CLONE });
  expect(fixture.events.slice(1)).toEqual([
    `replace:${DATA}/var/db/lsd/store.csstore:${TEMPLATE}>${CLONE}`,
    `replace:${DATA}/Library/Preferences/a.plist:${TEMPLATE}>${CLONE}`,
    `link:${DATA}/Library/Logs:${TEMPLATE}>${CLONE}`,
  ]);
  expect(result).toEqual({ rewrittenFiles: 2, retargetedLinks: 1, checkpointedDatabases: 0 });
});

test("checkpoints a WAL before rewriting and picks up a database that only held the UDID in its log", async () => {
  const fixture = new Fixture();
  const wal = `${DATA}/Library/Caches/CloudKit/CloudKitMetadata-wal`;
  const database = `${DATA}/Library/Caches/CloudKit/CloudKitMetadata`;
  fixture.scan = { files: [wal], links: [] };
  fixture.existing.add(database);
  fixture.withNeedleAfterCheckpoint.add(database);
  const result = await fixture.relocator.relocate({ templateUdid: TEMPLATE, cloneUdid: CLONE });
  expect(fixture.events.slice(1)).toEqual([
    `checkpoint:${database}`,
    `replace:${wal}:${TEMPLATE}>${CLONE}`,
    `replace:${database}:${TEMPLATE}>${CLONE}`,
  ]);
  expect(result.checkpointedDatabases).toBe(1);
});

test("does not rewrite a checkpointed database that no longer holds the UDID, nor twice one that does", async () => {
  const fixture = new Fixture();
  const walA = `${DATA}/a.sqlite-wal`;
  const walB = `${DATA}/b.sqlite-wal`;
  fixture.scan = { files: [`${DATA}/a.sqlite`, walA, walB], links: [] };
  fixture.existing.add(`${DATA}/a.sqlite`).add(`${DATA}/b.sqlite`);
  const result = await fixture.relocator.relocate({ templateUdid: TEMPLATE, cloneUdid: CLONE });
  const replaced = fixture.events.filter((event) => event.startsWith("replace:"));
  expect(replaced.filter((event) => event.includes("a.sqlite:"))).toHaveLength(1);
  expect(replaced.some((event) => event.includes("b.sqlite:"))).toBe(false);
  expect(result.checkpointedDatabases).toBe(2);
});

test("a WAL without a database is left alone", async () => {
  const fixture = new Fixture();
  fixture.scan = { files: [`${DATA}/orphan-wal`], links: [] };
  const result = await fixture.relocator.relocate({ templateUdid: TEMPLATE, cloneUdid: CLONE });
  expect(fixture.events.some((event) => event.startsWith("checkpoint:"))).toBe(false);
  expect(result.checkpointedDatabases).toBe(0);
});

test("a failed checkpoint is tolerated and the rewrite still isolates the clone", async () => {
  const fixture = new Fixture();
  const database = `${DATA}/Library/x.sqlite`;
  fixture.scan = { files: [`${database}-wal`], links: [`${DATA}/link`] };
  fixture.existing.add(database);
  fixture.failingCheckpoints.add(database);
  const result = await fixture.relocator.relocate({ templateUdid: TEMPLATE, cloneUdid: CLONE });
  expect(result).toEqual({ rewrittenFiles: 1, retargetedLinks: 1, checkpointedDatabases: 0 });
});

test("rejects values that are not simulator UDIDs before touching disk", async () => {
  const fixture = new Fixture();
  await expect(
    fixture.relocator.relocate({ templateUdid: "cloned", cloneUdid: CLONE }),
  ).rejects.toThrow("both must be simulator UDIDs");
  expect(fixture.events).toEqual([]);
});

test("an aborted signal stops the rewrite between files", async () => {
  const fixture = new Fixture();
  fixture.scan = { files: [`${DATA}/a`, `${DATA}/b`], links: [] };
  const controller = new AbortController();
  const replace = fixture.fs.replaceInFile;
  fixture.fs.replaceInFile = async (...args) => {
    await replace(...args);
    controller.abort(new Error("cancelled"));
  };
  await expect(
    fixture.relocator.relocate({
      templateUdid: TEMPLATE,
      cloneUdid: CLONE,
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled");
  expect(fixture.events.filter((event) => event.startsWith("replace:"))).toHaveLength(1);
});
