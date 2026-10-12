import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { join } from "node:path";
import {
  OWNERLESS_LOCK_RECLAIM_AGE_MS,
  type ExclusiveLockOptions,
  tryAcquireExclusiveLock,
} from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { useScratchRoot } from "../helpers/scratchRoot";

const scratch = useScratchRoot("file-lock-ownerless-");
let directory: string;
let path: string;
let timer: FakeTimer;
let expectedFiles: string[];
beforeEach(() => {
  directory = scratch.next();
  path = join(directory, "ownerless.lock");
  timer = new FakeTimer();
  timer.setCurrentTime(1_800_000_000_000);
  expectedFiles = ["ownerless.lock"];
});
afterEach(() => {
  expect(fs.readdirSync(directory)).toEqual(expectedFiles);
});

function leaveLock(raw: string, age = OWNERLESS_LOCK_RECLAIM_AGE_MS + 1): void {
  fs.writeFileSync(path, raw);
  const seconds = (timer.now() - age) / 1000;
  fs.utimesSync(path, seconds, seconds);
}

function acquire(options: ExclusiveLockOptions = {}): boolean {
  return tryAcquireExclusiveLock(path, {
    pid: 100,
    ownerToken: "ours",
    now: () => timer.now(),
    isProcessRunning: () => true,
    ...options,
  });
}

test.each(["", "  \n\t", "not-a-pid\ntoken", "0\ntoken", "-1\ntoken"])(
  "reclaims an old ownerless lock %j with our PID and token",
  (raw) => {
    leaveLock(raw);
    expect(acquire()).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toBe("100\nours");
  },
);

test.each([OWNERLESS_LOCK_RECLAIM_AGE_MS - 1, OWNERLESS_LOCK_RECLAIM_AGE_MS, -1])(
  "holds an empty lock with age %d (strictly older than the bound only)",
  (age) => {
    leaveLock("", age);
    const before = fs.statSync(path);
    expect(acquire()).toBe(false);
    expect(fs.readFileSync(path, "utf8")).toBe("");
    expect(fs.statSync(path).ino).toBe(before.ino);
    expect(fs.statSync(path).mtimeMs).toBe(before.mtimeMs);
  },
);

test("holds an old parseable LIVE owner without changing its content", () => {
  leaveLock("200\nowner", 60_000);
  const liveness = (pid: number) => {
    expect(pid).toBe(200);
    return true;
  };
  expect(acquire({ isProcessRunning: liveness })).toBe(false);
  expect(fs.readFileSync(path, "utf8")).toBe("200\nowner");
});

test.each([0, 60_000])("reclaims a DEAD owner through liveness at age %d", (age) => {
  leaveLock("200\nowner", age);
  expect(
    acquire({
      isProcessRunning: (pid) => {
        expect(pid).toBe(200);
        return false;
      },
    }),
  ).toBe(true);
  expect(fs.readFileSync(path, "utf8")).toBe("100\nours");
});

test.each([
  [101, 100, true],
  [100, 100, false],
  [20_000, 30_000, false],
  [-1, -2, false],
])("honours custom ownerless bound (age %d, bound %d)", (age, bound, reclaimed) => {
  leaveLock("", age);
  expect(acquire({ ownerlessReclaimAgeMs: bound })).toBe(reclaimed);
  expect(fs.readFileSync(path, "utf8")).toBe(reclaimed ? "100\nours" : "");
});

test.each(["pid-written", "fresh-inode", "changed-mtime", "changed-raw"] as const)(
  "restores a displaced ownerless file when %s races with rename",
  (race) => {
    leaveLock("");
    const realRename = fs.renameSync;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (race === "fresh-inode") {
        // Preserve the old inode under another name so the replacement cannot recycle it.
        realRename(path, join(directory, "old"));
        leaveLock("");
        fs.unlinkSync(join(directory, "old"));
      } else if (race === "changed-mtime") {
        leaveLock("", OWNERLESS_LOCK_RECLAIM_AGE_MS + 2);
      } else {
        leaveLock(race === "pid-written" ? "200\nowner" : " \n");
      }
      realRename(from, to);
    });
    try {
      expect(acquire()).toBe(false);
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(path, "utf8")).toBe(
      race === "pid-written" ? "200\nowner" : race === "changed-raw" ? " \n" : "",
    );
  },
);

test.each(["stat", "read", "marker-stat", "marker-read"] as const)(
  "backs off and logs when the ownerless %s sample fails",
  (failure) => {
    leaveLock("");
    const realStat = fs.statSync;
    const realRead = fs.readFileSync;
    let pathReads = 0;
    const stat = spyOn(fs, "statSync").mockImplementation((file, options) => {
      if (
        (failure === "stat" && file === path) ||
        (failure === "marker-stat" && file === `${path}.100.reclaim`)
      ) {
        throw new Error("sample unavailable");
      }
      return realStat(file, options);
    });
    const read = spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === path) {
        pathReads++;
      }
      if (
        (failure === "read" && file === path && pathReads === 2) ||
        (failure === "marker-read" && file === `${path}.100.reclaim`)
      ) {
        throw new Error("sample unavailable");
      }
      return realRead(file, options);
    });
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      expect(acquire()).toBe(false);
      expect(debug).toHaveBeenCalled();
    } finally {
      stat.mockRestore();
      read.mockRestore();
      debug.mockRestore();
    }
    expect(fs.readFileSync(path, "utf8")).toBe("");
  },
);

test("backs off and removes the marker after EEXIST even when the destination disappears", () => {
  leaveLock("");
  expectedFiles = [];
  const marker = `${path}.100.reclaim`;
  const realRead = fs.readFileSync;
  const read = spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === marker) {
      throw new Error("marker sample unavailable");
    }
    return realRead(file, options);
  });
  const link = spyOn(fs, "linkSync").mockImplementation((from, to) => {
    expect(from).toBe(marker);
    expect(to).toBe(path);
    fs.writeFileSync(path, "200\ncompetitor");
    // Another reclaimer removes the occupied destination before the failed link returns.
    fs.unlinkSync(path);
    throw Object.assign(new Error("destination occupied"), { code: "EEXIST" });
  });
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    expect(acquire()).toBe(false);
    expect(link).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("restore destination occupied"));
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    read.mockRestore();
    link.mockRestore();
    debug.mockRestore();
  }
});

test("throws for a non-EEXIST restore failure when the destination is absent", () => {
  leaveLock("");
  expectedFiles = ["ownerless.lock.100.reclaim"];
  const marker = `${path}.100.reclaim`;
  const realRead = fs.readFileSync;
  const read = spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === marker) {
      throw new Error("marker sample unavailable");
    }
    return realRead(file, options);
  });
  const link = spyOn(fs, "linkSync").mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  });
  try {
    expect(() => acquire()).toThrow(`Failed to restore displaced lock at ${path}`);
    expect(link).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path)).toBe(false);
  } finally {
    read.mockRestore();
    link.mockRestore();
  }
  expect(fs.readFileSync(marker, "utf8")).toBe("");
});
