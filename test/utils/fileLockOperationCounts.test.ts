import { expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
  type LockStep,
} from "../../src/utils/fileLock";
import { fixture, PATH, prefix } from "./fileLockRaceHarness";

const WRITE_CLASS = new Set<LockStep["op"]>([
  "mkdir",
  "writeFile",
  "link",
  "rename",
  "unlink",
  "openExclusive",
  "write",
  "close",
]);
type Operation = { op: LockStep["op"]; kind: string };
const op = (operation: LockStep["op"], kind: string): Operation => ({ op: operation, kind });
const SAMPLE = [op("stat", "lock"), op("readText", "lock")];
const PUBLISH_LOCK = [
  op("unlink", "lock-tmp"),
  op("writeFile", "lock-tmp"),
  op("link", "lock"),
  op("unlink", "lock-tmp"),
];
const REMOVE_STALE = [
  ...SAMPLE,
  op("rename", "lock"),
  op("stat", "marker"),
  op("readText", "marker"),
  op("unlink", "marker"),
  op("mkdir", "dir"),
  ...PUBLISH_LOCK,
];

function publishGuard(slot: number): Operation[] {
  return [
    op("unlink", `guard.${slot}-tmp`),
    op("writeFile", `guard.${slot}-tmp`),
    op("link", `guard.${slot}`),
    op("unlink", `guard.${slot}-tmp`),
  ];
}

function prepare(unrelated: number, raw = "99\nstale") {
  const f = fixture(raw);
  if (raw === "") {
    f.fs.update(PATH, raw, f.clock.now());
  }
  for (let i = 0; i < unrelated; i++) {
    f.fs.seed(`/locks/unrelated-${i}`, "unrelated", 0);
  }
  const base = prefix(f.fs);
  f.fs.operations.length = 0;
  const kind = (path: string): string => {
    if (path === PATH) {
      return "lock";
    }
    if (path === dirname(PATH)) {
      return "dir";
    }
    for (const slot of [0, 1]) {
      if (path === `${base}.${slot}`) {
        return `guard.${slot}`;
      }
      if (path.startsWith(`${base}.${slot}.`) && path.endsWith(".tmp")) {
        return `guard.${slot}-tmp`;
      }
    }
    if (path.startsWith(`${PATH}.`) && path.endsWith(".tmp")) {
      return "lock-tmp";
    }
    if (path === `${PATH}.101.reclaim` || path.startsWith(`${PATH}.101.release.`)) {
      return "marker";
    }
    throw new Error(`Unpinned operation path: ${path}`);
  };
  const verify = (expected: Operation[], total: number, writes: number): void => {
    expect(f.fs.operations.map(({ op, path }) => ({ op, kind: kind(path) }))).toEqual(expected);
    // Raising either numeric budget needs a justification in the PR.
    expect(f.fs.operations).toHaveLength(total);
    expect(f.fs.operations.filter(({ op }) => WRITE_CLASS.has(op))).toHaveLength(writes);
  };
  return { ...f, base, verify };
}

test.each([0, 100])(
  "uncontended acquire then release, %d unrelated entries: 11 total / 7 writes",
  (unrelated) => {
    const f = prepare(unrelated);
    f.fs.unlink(PATH);
    f.fs.operations.length = 0;
    expect(tryAcquireExclusiveLock(PATH, f.options(101))).toBe(true);
    releaseExclusiveLock(PATH, 101, "owner-101", f.fs);
    f.verify(
      [
        op("stat", "lock"),
        op("mkdir", "dir"),
        op("list", "dir"),
        ...PUBLISH_LOCK,
        op("readText", "lock"),
        op("rename", "lock"),
        op("readText", "marker"),
        op("unlink", "marker"),
      ],
      11,
      7,
    );
  },
);

test.each(["202\nlive", ""])("contended live/young-ownerless %j: 2 total / 0 writes", (raw) => {
  const f = prepare(100, raw);
  expect(tryAcquireExclusiveLock(PATH, f.options(101))).toBe(false);
  f.verify(SAMPLE, 2, 0);
  expect(f.fs.operations.some(({ op }) => op === "list")).toBe(false);
});

test.each([0, 100])("dead owner, k=0, %d unrelated entries: 20 total / 12 writes", (unrelated) => {
  const f = prepare(unrelated);
  expect(tryAcquireExclusiveLock(PATH, f.options(101))).toBe(true);
  f.verify(
    [
      ...SAMPLE,
      op("list", "dir"),
      ...publishGuard(0),
      ...REMOVE_STALE,
      op("readText", "guard.0"),
      op("unlink", "guard.0"),
    ],
    20,
    12,
  );
});

test.each([0, 100])(
  "dead owner and dead guard, k=1, %d unrelated entries: 35 total / 21 writes",
  (unrelated) => {
    const f = prepare(unrelated);
    f.fs.seed(`${f.base}.0`, "98\ndead", 0);
    f.fs.operations.length = 0;
    expect(tryAcquireExclusiveLock(PATH, f.options(101))).toBe(true);
    f.verify(
      [
        ...SAMPLE,
        op("list", "dir"),
        ...publishGuard(0),
        op("stat", "guard.0"),
        op("readText", "guard.0"),
        ...publishGuard(1),
        op("stat", "guard.0"),
        op("readText", "guard.0"),
        op("unlink", "guard.0-tmp"),
        op("writeFile", "guard.0-tmp"),
        op("rename", "guard.0-tmp"),
        op("unlink", "guard.0-tmp"),
        op("readText", "guard.1"),
        op("unlink", "guard.1"),
        ...REMOVE_STALE,
        op("readText", "guard.1"),
        op("readText", "guard.0"),
        op("unlink", "guard.0"),
      ],
      35,
      21,
    );
  },
);
