import { expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { readProcProcessTable } from "../../../src/features/bootAdmission/procProcessTable";
import { parsePsSnapshot } from "../../../src/features/iosSimFleet/psSnapshot";
import { logger } from "../../../src/utils/logger";
import { FakeProcFs } from "../../fakes/FakeProcFs";

const STATUS = readFileSync(
  new URL(
    "../../fixtures/android-boot-admission/proc-status-upstream-man-proc_pid_status.txt",
    import.meta.url,
  ),
  "utf8",
);
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

function populated(count = 1): FakeProcFs {
  const fs = new FakeProcFs();
  fs.entries = Array.from({ length: count }, (_, i) => String(17248 + i));
  for (const pid of fs.entries) {
    fs.files.set(`/proc/${pid}/status`, STATUS);
    fs.files.set(`/proc/${pid}/cmdline`, CMDLINE);
  }
  return fs;
}

// Other pids and kernel threads are structured edits of upstream documentation, not captures.
function editStatus(edits: Record<string, string>, dropMemory = false): string {
  return STATUS.split("\n")
    .flatMap((line) => {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon);
      if (dropMemory && (key.startsWith("Vm") || key.startsWith("Rss"))) {
        return [];
      }
      return [key in edits ? `${key}:\t${edits[key]}` : line];
    })
    .join("\n");
}

test("proc: upstream status and captured argv produce the narrow Android row", async () => {
  expect(await readProcProcessTable(populated())).toEqual([
    { pid: 17248, ppid: 17200, rssBytes: 13484 * 1024, command: COMMAND },
  ]);
});

test("proc: kernel thread derived from upstream status has zero RSS and bracketed Name", async () => {
  const fs = populated();
  fs.files.set(
    "/proc/17248/status",
    editStatus({ Name: "kthreadd", Pid: "17248", PPid: "0" }, true),
  );
  fs.files.set("/proc/17248/cmdline", "");
  expect(await readProcProcessTable(fs)).toEqual([
    { pid: 17248, ppid: 0, rssBytes: 0, command: "[kthreadd]" },
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
  fs.files.set("/proc/17248/status", editStatus({ PPid: "17200 junk" }));
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
