import { expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { readProcProcessTable } from "../../../src/features/bootAdmission/procProcessTable";
import { parsePsSnapshot } from "../../../src/features/iosSimFleet/psSnapshot";
import { logger } from "../../../src/utils/logger";
import { FakeProcFs } from "../../fakes/FakeProcFs";

function capture(name: string, file: "status.txt" | "cmdline.bin"): string {
  // latin1 maps bytes 1:1, so NUL separators and raw bytes survive the string seam.
  return readFileSync(
    new URL(`../../fixtures/android-boot-admission/proc-${name}-${file}`, import.meta.url),
    "latin1",
  );
}
const NORMAL = {
  status: capture("alpine-normal", "status.txt"),
  cmdline: capture("alpine-normal", "cmdline.bin"),
};
const PS = readFileSync(
  new URL(
    "../../fixtures/android-boot-admission/ps-snapshot-one-running-emulator.txt",
    import.meta.url,
  ),
  "utf8",
);
const COMMAND = parsePsSnapshot(PS).rows.find((row) =>
  row.command.includes("qemu-system-"),
)!.command;
const CMDLINE = COMMAND.split(" ").join("\0") + "\0"; // argv derived from the captured qemu row.

/** Captured status (alpine sleep, pid 13) paired with a qemu argv, repeated under distinct pids. */
function populated(count = 1): FakeProcFs {
  const fs = new FakeProcFs();
  fs.entries = Array.from({ length: count }, (_, i) => String(17248 + i));
  for (const pid of fs.entries) {
    fs.files.set(`/proc/${pid}/status`, NORMAL.status);
    fs.files.set(`/proc/${pid}/cmdline`, CMDLINE);
  }
  return fs;
}

function single(name: string, pid: string): FakeProcFs {
  const fs = new FakeProcFs();
  fs.entries = [pid];
  fs.files.set(`/proc/${pid}/status`, capture(name, "status.txt"));
  fs.files.set(`/proc/${pid}/cmdline`, capture(name, "cmdline.bin"));
  return fs;
}

test("proc: captured alpine sleep produces its row from real kernel bytes", async () => {
  expect(await readProcProcessTable(single("alpine-normal", "13"))).toEqual([
    { pid: 13, ppid: 1, rssBytes: 1008 * 1024, command: "sleep 60" },
  ]);
});

test("proc: captured status with a qemu argv produces the narrow Android row", async () => {
  expect(await readProcProcessTable(populated())).toEqual([
    { pid: 17248, ppid: 1, rssBytes: 1008 * 1024, command: COMMAND },
  ]);
});

test.each([
  ["alpine-pid1", { pid: 1, ppid: 0, rssBytes: 1144 * 1024, command: "sh -s" }],
  ["debian-pid1", { pid: 1, ppid: 0, rssBytes: 1820 * 1024, command: "sh -s" }],
  // Name is `my (proc) x`; the row command comes from argv, not comm.
  [
    "alpine-comm-name",
    { pid: 126, ppid: 1, rssBytes: 904 * 1024, command: "/bin/sh /tmp/my (proc) x" },
  ],
  // exec -a changes argv[0] only; Name stays `sleep`.
  ["debian-argv0-spoof", { pid: 21, ppid: 1, rssBytes: 1752 * 1024, command: "my (proc) x 60" }],
])("proc: captured %s parses to its row", async (name, expected) => {
  expect(await readProcProcessTable(single(name, String(expected.pid)))).toEqual([expected]);
});

test("proc: captured zombie has no VmRSS and an empty cmdline, so it is bracketed by Name", async () => {
  expect(await readProcProcessTable(single("alpine-zombie", "144"))).toEqual([
    { pid: 144, ppid: 142, rssBytes: 0, command: "[sleep]" },
  ]);
});

test.each(["ENOENT", "ESRCH"])(
  "proc: skips exited %s pids and nonnumeric entries",
  async (code) => {
    const fs = populated(2);
    fs.entries.push("self", "thread-self", "sys", "123junk");
    fs.files.set("/proc/17249/cmdline", Object.assign(new Error("exited"), { code }));
    const debug = spyOn(logger, "debug").mockImplementation(() => undefined);
    try {
      expect(await readProcProcessTable(fs)).toHaveLength(1);
      expect(fs.reads.every((path) => /^\/proc\/\d+\//.test(path))).toBe(true);
      expect(debug.mock.calls.some(([message]) => message.includes("17249"))).toBe(true);
    } finally {
      debug.mockRestore();
    }
  },
);

test("proc: counts malformed PPid and rejects zero rows as unparseable", async () => {
  const fs = populated();
  // Synthetic parser-robustness case (not a capture): a captured status with PPid corrupted.
  fs.files.set("/proc/17248/status", NORMAL.status.replace(/^PPid:.*$/m, "PPid:\t1 junk"));
  await expect(readProcProcessTable(fs)).rejects.toThrow(
    "no parseable processes (1 unparseable rows)",
  );
});

test("proc: ignores empty directory entries and rejects an empty table", async () => {
  const fs = new FakeProcFs();
  fs.entries = ["self", "", "sys"];
  await expect(readProcProcessTable(fs)).rejects.toThrow("no parseable processes");
  expect(fs.reads).toHaveLength(0);
});

test("proc: bounds reads and checks abort before the next batch", async () => {
  const fs = populated(100);
  const rows = await readProcProcessTable(fs);
  expect(rows).toHaveLength(100);
  expect(fs.maxActiveReads).toBeLessThanOrEqual(32);
  const controller = new AbortController();
  const reason = new Error("cancel proc scan");
  fs.reads.length = 0;
  fs.onRead = async () => {
    controller.abort(reason);
  };
  await expect(readProcProcessTable(fs, { signal: controller.signal })).rejects.toBe(reason);
  expect(fs.reads.length).toBeLessThan(200);
});

test.each(["EACCES", "EPERM"])("proc: propagates %s on the root", async (code) => {
  const fs = new FakeProcFs();
  const error = Object.assign(new Error("denied"), { code });
  fs.listError = error;
  await expect(readProcProcessTable(fs)).rejects.toBe(error);
});

test.each(["EACCES", "EPERM"])(
  "proc: retains six readable qemu rows when pid 1 status rejects %s",
  async (code) => {
    const fs = populated(6);
    fs.entries.unshift("1");
    fs.files.set("/proc/1/status", Object.assign(new Error("restricted pid"), { code }));
    const debug = spyOn(logger, "debug").mockImplementation(() => undefined);
    try {
      const rows = await readProcProcessTable(fs);
      expect(rows.map((row) => row.pid)).toEqual([17248, 17249, 17250, 17251, 17252, 17253]);
      expect(rows.every((row) => row.command === COMMAND)).toBe(true);
      expect(debug.mock.calls.some(([message]) => message.includes("/proc/1"))).toBe(true);
      expect(debug.mock.calls.some(([message]) => message.includes("skipped 1"))).toBe(true);
    } finally {
      debug.mockRestore();
    }
  },
);

test("proc: retains readable rows when a cmdline read rejects a plain EPERM object", async () => {
  const fs = populated(2);
  fs.onRead = async (path) => {
    if (path === "/proc/17249/cmdline") {
      throw { code: "EPERM" };
    }
  };
  expect((await readProcProcessTable(fs)).map((row) => row.pid)).toEqual([17248]);
});

test("proc: a per-pid EIO fails the table even with six readable qemu rows", async () => {
  const fs = populated(6);
  fs.entries.unshift("1");
  const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
  fs.files.set("/proc/1/status", error);
  await expect(readProcProcessTable(fs)).rejects.toMatchObject({ cause: error });
});
