import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AndroidProtoViewer,
  PROTOVIEWER_PREPARE_TIMEOUT_MS,
  PROTOVIEWER_RESULT_POLL_MS,
  ProtoViewerEntryPointMissingError,
  ProtoViewerStorageError,
  type ProtoViewerTempFiles,
} from "../../../../src/features/prototype/protoViewer/AndroidProtoViewer";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { ExecResult } from "../../../../src/models";
import type { AdbExecuteOptions } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";

const PACKAGE = "dev.jasonpearson.automobile.protoviewer";
const ROOT = `/sdcard/Android/data/${PACKAGE}/files/mcp`;
const LIBRARY_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const REQUEST = "mcp-req1";
// Real captures from the API 37 emulator run that found #15174.
const CAPTURES = new URL("../../../fixtures/android-protoviewer/", import.meta.url);
const CAT_MISSING_EXIT_1 = readFileSync(
  new URL("cat-missing-result-exit1.txt", CAPTURES),
  "utf8",
).trim();
const NO_PUSHED_PROTOTYPE = readFileSync(
  new URL("rejected-no-pushed-prototype.json", CAPTURES),
  "utf8",
);
const START = `shell am start -W --activity-multiple-task --user 0 -n ${PACKAGE}/.McpActivity`;
const READY_PROBE = `shell if [ -d '${ROOT}/inbox' ] && [ -d '${ROOT}/results' ] && [ ! -O '${ROOT}' ] && [ ! -O '${ROOT}/inbox' ] && [ ! -O '${ROOT}/results' ]; then echo ready; fi`;
const REMOVE_SHELL_OWNED = `shell for d in '${ROOT}' '${ROOT}/inbox' '${ROOT}/results'; do if [ -O "$d" ]; then rm -rf "$d"; fi; done`;
const resultProbe = (request: string) =>
  `shell if [ -f '${ROOT}/results/${request}.json' ]; then cat '${ROOT}/results/${request}.json'; fi`;

function exec(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

class RecordingTempFiles implements ProtoViewerTempFiles {
  readonly written: Uint8Array[] = [];
  disposed = 0;
  async write(bytes: Uint8Array) {
    this.written.push(bytes);
    return {
      path: "C:\\Users\\O'Brien\\tmp\\bundle.automobile-proto",
      dispose: async () => {
        this.disposed++;
      },
    };
  }
}

interface Launch {
  readonly action: string;
  readonly request: string;
}

/**
 * A device whose shared storage behaves like API 37 FUSE as captured in #15174: the host's remote
 * `cat` of a file that is not there yet exits 1 (adb reports it as a thrown error), so the poll
 * must never use a bare `cat`. Folders exist only when the app made them.
 */
class ScriptedProtoViewerAdb extends FakeAdbExecutor {
  readonly folders = new Set<string>();
  /** Folders the adb shell made (an older host's `mkdir -p`): shell-owned, unusable to the app. */
  readonly shellOwned = new Set<string>();
  readonly files = new Map<string, string>();
  private readonly pending = new Map<string, { json: string; probesLeft: number }>();
  private onLaunch: (launch: Launch) => void = () => {};
  private pushRefusal: string | undefined;

  whenLaunched(handler: (launch: Launch) => void): void {
    this.onLaunch = handler;
  }

  refusePushWith(stderr: string): void {
    this.pushRefusal = stderr;
  }

  /** The folders ProtoViewer creates for itself. */
  appCreatesFolders(): void {
    this.folders.add(`${ROOT}/inbox`);
    this.folders.add(`${ROOT}/results`);
  }

  /** The app's atomic result write, visible to the host after the given number of empty polls. */
  appWritesResult(
    request: string,
    result: object | string,
    emptyPollsFirst = 0,
    root = ROOT,
  ): void {
    const path = `${root}/results/${request}.json`;
    const json = typeof result === "string" ? result : JSON.stringify(result);
    this.pending.set(path, { json, probesLeft: emptyPollsFirst });
  }

  override async executeCommand(command: string, options: AdbExecuteOptions = {}) {
    const recorded = await super.executeCommand(command, options);
    const launch = /^shell am start .* -a (\S+) --es request (\S+)/.exec(command);
    if (launch) {
      this.onLaunch({ action: launch[1].replace(`${PACKAGE}.mcp.`, ""), request: launch[2] });
      return recorded;
    }
    if (command.startsWith("shell if [ -d ")) {
      const [inbox, results, ...owned] = [...command.matchAll(/'([^']+)'/g)].map(
        ([, path]) => path,
      );
      const usable = this.folders.has(inbox) && this.folders.has(results);
      return exec(usable && !owned.some((path) => this.shellOwned.has(path)) ? "ready\n" : "");
    }
    if (command.startsWith("shell for d in ")) {
      for (const [, path] of command.split("; do")[0].matchAll(/'([^']+)'/g)) {
        if (this.shellOwned.delete(path)) {
          this.folders.delete(path);
        }
      }
      return recorded;
    }
    const probe = /^shell if \[ -f '([^']+)' \]; then cat '([^']+)'; fi$/.exec(command);
    if (probe) {
      return exec(this.read(probe[1]));
    }
    const bareCat = /^shell cat '([^']+)'/.exec(command);
    if (bareCat) {
      const found = this.read(bareCat[1]);
      if (found === "") {
        throw new Error(CAT_MISSING_EXIT_1);
      }
      return exec(found);
    }
    if (command.startsWith("shell rm -f ")) {
      for (const [, path] of command.matchAll(/'([^']+)'/g)) {
        this.files.delete(path);
        this.pending.delete(path);
      }
      return recorded;
    }
    if (command.startsWith("push ")) {
      const destination = command.slice(command.lastIndexOf(" ") + 1);
      if (this.pushRefusal !== undefined) {
        // adb exits 1 when the device refuses, and the executor throws on a non-zero exit.
        throw new Error(this.pushRefusal);
      }
      if (!this.folders.has(destination.slice(0, destination.lastIndexOf("/")))) {
        return exec(
          "",
          `adb: error: failed to copy to '${destination}': No such file or directory`,
        );
      }
      this.files.set(destination, "bundle");
    }
    return recorded;
  }

  private read(path: string): string {
    const pending = this.pending.get(path);
    if (pending) {
      if (pending.probesLeft > 0) {
        pending.probesLeft--;
        return "";
      }
      this.pending.delete(path);
      this.files.set(path, pending.json);
    }
    return this.files.get(path) ?? "";
  }
}

describe("AndroidProtoViewer", () => {
  let adb: ScriptedProtoViewerAdb;
  let timer: FakeTimer;
  let temp: RecordingTempFiles;
  let viewer: AndroidProtoViewer;

  const imported = (label = "Demo") => ({
    status: "imported" as const,
    request: REQUEST,
    libraryId: LIBRARY_ID,
    label,
  });
  const shellCommands = () =>
    adb.getExecutedCommands().filter((command) => command.startsWith("shell"));

  beforeEach(() => {
    adb = new ScriptedProtoViewerAdb();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    temp = new RecordingTempFiles();
    viewer = new AndroidProtoViewer({
      adb,
      timer,
      ids: new FakeIdGenerator(["req1", "prep1"]),
      tempFiles: temp,
    });
    adb.setCommandResponse("am get-current-user", exec("0\n"));
  });

  test("reports the current user only when ProtoViewer is installed for it", async () => {
    adb.setCommandResponse("pm list packages --user 0", exec(`package:${PACKAGE}\n`));
    expect(await viewer.installedUser()).toBe(0);
    adb.setCommandResponse("pm list packages --user 0", exec("package:com.example\n"));
    expect(await viewer.installedUser()).toBeUndefined();
  });

  test("the captured API 37 failure: a remote cat of a missing result exits 1 and adb throws", async () => {
    // Why the poll below never runs a bare `cat`: this is what the fake (and the device) does.
    await expect(
      adb.executeCommand(`shell cat '${ROOT}/results/${REQUEST}.json' 2>/dev/null`),
    ).rejects.toThrow("exit code: 1");
  });

  test("a first save has the app create its folders, then pushes, starts, reads and cleans up", async () => {
    adb.whenLaunched(({ action, request }) => {
      if (action === "PREPARE") {
        adb.appCreatesFolders();
        adb.appWritesResult(request, { status: "prepared", request });
      } else {
        adb.appWritesResult(request, imported("It's mine"));
      }
    });
    const result = await viewer.importBundle(0, new Uint8Array([1, 2, 3]), "It's mine", 5000);

    expect(result).toEqual(imported("It's mine"));
    expect(temp.written).toEqual([new Uint8Array([1, 2, 3])]);
    expect(temp.disposed).toBe(1);
    // The host path travels as one argv element, so quotes in it never reach a parser.
    expect(adb.getExecutedArgv()).toEqual([
      [
        "push",
        "C:\\Users\\O'Brien\\tmp\\bundle.automobile-proto",
        `${ROOT}/inbox/${REQUEST}.automobile-proto`,
      ],
    ]);
    expect(shellCommands()).toEqual([
      READY_PROBE,
      REMOVE_SHELL_OWNED,
      `${START} -a ${PACKAGE}.mcp.PREPARE --es request mcp-prep1`,
      resultProbe("mcp-prep1"),
      `shell rm -f '${ROOT}/results/mcp-prep1.json'`,
      READY_PROBE,
      `${START} -a ${PACKAGE}.mcp.IMPORT --es request ${REQUEST} --es label 'It'\\''s mine'`,
      resultProbe(REQUEST),
      `shell rm -f '${ROOT}/results/${REQUEST}.json' '${ROOT}/inbox/${REQUEST}.automobile-proto'`,
    ]);
    // The shell never creates a folder: a shell-owned one is unusable to the app.
    expect(shellCommands().some((command) => command.includes("mkdir"))).toBe(false);
  });

  test("folders the app already made are not prepared again", async () => {
    adb.appCreatesFolders();
    adb.whenLaunched(({ request }) => adb.appWritesResult(request, imported()));
    await viewer.importBundle(0, new Uint8Array([1]), undefined, 5000);
    expect(shellCommands()).toEqual([
      READY_PROBE,
      `${START} -a ${PACKAGE}.mcp.IMPORT --es request ${REQUEST}`,
      resultProbe(REQUEST),
      `shell rm -f '${ROOT}/results/${REQUEST}.json' '${ROOT}/inbox/${REQUEST}.automobile-proto'`,
    ]);
    expect(adb.getExecutedCommands().some((command) => command.includes("--es label"))).toBe(false);
  });

  test("a result that is not there yet is pending, not an error, until the app writes it", async () => {
    adb.appCreatesFolders();
    adb.whenLaunched(({ request }) =>
      adb.appWritesResult(
        request,
        { status: "rejected", request, path: "spec.json:/root", reason: "bad" },
        2,
      ),
    );
    const result = await viewer.importBundle(0, new Uint8Array([1]), undefined, 5000);
    expect(result).toEqual({
      status: "rejected",
      request: REQUEST,
      path: "spec.json:/root",
      reason: "bad",
    });
    expect(timer.getSleepHistory()).toEqual([
      PROTOVIEWER_RESULT_POLL_MS,
      PROTOVIEWER_RESULT_POLL_MS,
    ]);
    expect(shellCommands().some((command) => /^shell cat /.test(command))).toBe(false);
  });

  test("gives up at the deadline, says the save may have landed, and still removes its files", async () => {
    adb.appCreatesFolders();
    await expect(viewer.importBundle(0, new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
      "may still have saved the prototype",
    );
    expect(timer.getSleepCallCount()).toBe(1000 / PROTOVIEWER_RESULT_POLL_MS);
    expect(adb.wasCommandExecuted(`shell rm -f '${ROOT}/results/${REQUEST}.json'`)).toBe(true);
  });

  test("a cancelled call still removes its pushed bundle", async () => {
    adb.appCreatesFolders();
    adb.setThrowOnAbortedSignal();
    const controller = new AbortController();
    // Cancelled while waiting for the app, after the bundle was pushed.
    adb.abortAfterCommand("if [ -f ", controller);
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 5000, controller.signal),
    ).rejects.toBeDefined();
    const cleanup = adb.getCommandCalls().find((call) => call.command.startsWith("shell rm -f"));
    expect(cleanup?.command).toContain(`${ROOT}/inbox/${REQUEST}.automobile-proto`);
    expect(cleanup?.signal).toBeUndefined();
    expect(cleanup?.timeoutMs).toBe(5000);
  });

  test("an older ProtoViewer without the MCP activity is reported as a missing entry point", async () => {
    adb.appCreatesFolders();
    adb.setCommandResponse(
      "am start",
      exec(
        "Error type 3\nError: Activity class {dev.jasonpearson.automobile.protoviewer/dev.jasonpearson.automobile.protoviewer.McpActivity} does not exist.",
      ),
    );
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 1000),
    ).rejects.toBeInstanceOf(ProtoViewerEntryPointMissingError);
    expect(adb.wasCommandExecuted("if [ -f ")).toBe(false);
  });

  test("the missing entry point is not hidden as a storage problem while preparing", async () => {
    adb.setCommandResponse("am start", exec("Error type 3\nError: Activity class does not exist."));
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 1000),
    ).rejects.toBeInstanceOf(ProtoViewerEntryPointMissingError);
  });

  test("a launch the system dropped fails at once instead of waiting for the deadline", async () => {
    adb.appCreatesFolders();
    adb.setCommandResponse(
      "am start",
      exec("Warning: Activity not started, its current task has been brought to the front"),
    );
    await expect(viewer.importBundle(0, new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
      "Could not start ProtoViewer",
    );
    expect(adb.wasCommandExecuted("if [ -f ")).toBe(false);
  });

  test("folders left shell-owned by an older host are removed, then the app makes its own", async () => {
    for (const folder of [ROOT, `${ROOT}/inbox`, `${ROOT}/results`]) {
      adb.shellOwned.add(folder);
      adb.folders.add(folder);
    }
    adb.whenLaunched(({ action, request }) => {
      if (action === "PREPARE") {
        adb.appCreatesFolders();
        adb.appWritesResult(request, { status: "prepared", request });
      } else {
        adb.appWritesResult(request, imported());
      }
    });
    expect((await viewer.importBundle(0, new Uint8Array([1]), undefined, 5000)).status).toBe(
      "imported",
    );
    expect(shellCommands().slice(0, 3)).toEqual([
      READY_PROBE,
      REMOVE_SHELL_OWNED,
      `${START} -a ${PACKAGE}.mcp.PREPARE --es request mcp-prep1`,
    ]);
  });

  test("an app that cannot create its folders (shell-owned) is a storage error before any push", async () => {
    // No answer to PREPARE: the app cannot write a result into a folder the shell owns.
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 15_000),
    ).rejects.toBeInstanceOf(ProtoViewerStorageError);
    expect(adb.getExecutedArgv()).toEqual([]);
    expect(temp.written).toEqual([]);
    // Waits only the prepare budget, not the caller's whole 15 s.
    expect(timer.getSleepCallCount()).toBe(
      PROTOVIEWER_PREPARE_TIMEOUT_MS / PROTOVIEWER_RESULT_POLL_MS,
    );
  });

  test("an app that answers prepare but leaves the folders missing is a storage error", async () => {
    adb.whenLaunched(({ request }) =>
      adb.appWritesResult(request, { status: "prepared", request }),
    );
    await expect(viewer.importBundle(0, new Uint8Array([1]), undefined, 5000)).rejects.toThrow(
      "folders are not there",
    );
  });

  test("a refused push is a storage error, disposes the temp file and never launches the app", async () => {
    adb.appCreatesFolders();
    adb.refusePushWith(
      "adb: error: failed to copy: remote couldn't create file: Permission denied",
    );
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 5000),
    ).rejects.toBeInstanceOf(ProtoViewerStorageError);
    expect(temp.disposed).toBe(1);
    expect(adb.wasCommandExecuted("am start")).toBe(false);
  });

  test("an app that cannot see the pushed file reports the captured rejection as a storage error", async () => {
    adb.appCreatesFolders();
    adb.whenLaunched(({ request }) =>
      adb.appWritesResult(request, { ...JSON.parse(NO_PUSHED_PROTOTYPE), request }),
    );
    const failure = viewer.importBundle(0, new Uint8Array([1]), undefined, 5000);
    await expect(failure).rejects.toBeInstanceOf(ProtoViewerStorageError);
    await expect(failure).rejects.toThrow("No pushed prototype for this request");
    expect(adb.wasCommandExecuted(`shell rm -f '${ROOT}/results/${REQUEST}.json'`)).toBe(true);
  });

  test("a result for another request is never accepted", async () => {
    adb.appCreatesFolders();
    adb.whenLaunched(() =>
      adb.appWritesResult(REQUEST, { ...imported("x"), request: "mcp-stale" }),
    );
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 1000),
    ).rejects.toBeInstanceOf(ActionableError);
  });

  test("a malformed result is an error, while extra fields from a newer app are ignored", async () => {
    adb.appCreatesFolders();
    adb.whenLaunched(({ request }) =>
      adb.appWritesResult(request, { status: "imported", request }),
    );
    await expect(viewer.importBundle(0, new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
      "unexpected result",
    );
    adb.whenLaunched(({ request }) =>
      adb.appWritesResult(request, { ...imported("x"), status: "opened", request, code: 7 }),
    );
    expect((await viewer.open(0, LIBRARY_ID, 1000)).status).toBe("opened");
  });

  test("an import answered with a prepare result is refused", async () => {
    adb.appCreatesFolders();
    adb.whenLaunched(({ request }) =>
      adb.appWritesResult(request, { status: "prepared", request }),
    );
    await expect(viewer.importBundle(0, new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
      "prepare result",
    );
  });

  test("open starts the guarded activity with the library id for the given user", async () => {
    const root10 = `/storage/emulated/10/Android/data/${PACKAGE}/files/mcp`;
    adb.whenLaunched(({ request }) =>
      adb.appWritesResult(request, { ...imported("Demo"), status: "opened" }, 0, root10),
    );
    const result = await viewer.open(10, LIBRARY_ID, 5000);
    expect(result.status).toBe("opened");
    expect(adb.getExecutedCommands()).toEqual([
      `shell am start -W --activity-multiple-task --user 10 -n ${PACKAGE}/.McpActivity -a ${PACKAGE}.mcp.OPEN --es request ${REQUEST} --es libraryId '${LIBRARY_ID}'`,
      `shell if [ -f '${root10}/results/${REQUEST}.json' ]; then cat '${root10}/results/${REQUEST}.json'; fi`,
      `shell rm -f '${root10}/results/${REQUEST}.json'`,
    ]);
  });
});
