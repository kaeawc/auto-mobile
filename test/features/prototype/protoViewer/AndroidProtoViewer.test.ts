import { beforeEach, describe, expect, test } from "bun:test";
import {
  AndroidProtoViewer,
  PROTOVIEWER_RESULT_POLL_MS,
  ProtoViewerEntryPointMissingError,
  type ProtoViewerTempFiles,
} from "../../../../src/features/prototype/protoViewer/AndroidProtoViewer";
import { ActionableError } from "../../../../src/models/ActionableError";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";

const PACKAGE = "dev.jasonpearson.automobile.protoviewer";
const ROOT = `/sdcard/Android/data/${PACKAGE}/files/mcp`;
const LIBRARY_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const REQUEST = "mcp-req1";
const START = `shell am start -W --activity-multiple-task --user 0 -n ${PACKAGE}/.McpActivity`;

function exec(stdout: string, stderr = "") {
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

describe("AndroidProtoViewer", () => {
  let adb: FakeAdbExecutor;
  let timer: FakeTimer;
  let temp: RecordingTempFiles;
  let viewer: AndroidProtoViewer;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    temp = new RecordingTempFiles();
    viewer = new AndroidProtoViewer({
      adb,
      timer,
      ids: new FakeIdGenerator(["req1"]),
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

  test("import pushes into the app-scoped inbox, starts the guarded activity, reads and cleans up", async () => {
    adb.setCommandResponse(
      "cat '",
      exec(
        JSON.stringify({
          status: "imported",
          request: REQUEST,
          libraryId: LIBRARY_ID,
          label: "It's mine",
        }),
      ),
    );
    const result = await viewer.importBundle(0, new Uint8Array([1, 2, 3]), "It's mine", 5000);

    expect(result).toEqual({
      status: "imported",
      request: REQUEST,
      libraryId: LIBRARY_ID,
      label: "It's mine",
    });
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
    const shellCommands = adb
      .getExecutedCommands()
      .filter((command) => command.startsWith("shell"));
    expect(shellCommands).toEqual([
      `shell mkdir -p '${ROOT}/inbox'`,
      `${START} -a ${PACKAGE}.mcp.IMPORT --es request ${REQUEST} --es label 'It'\\''s mine'`,
      `shell cat '${ROOT}/results/${REQUEST}.json' 2>/dev/null`,
      `shell rm -f '${ROOT}/results/${REQUEST}.json' '${ROOT}/inbox/${REQUEST}.automobile-proto'`,
    ]);
  });

  test("polls until the app has written its result", async () => {
    adb.setCommandResponseSequence("cat '", [
      exec(""),
      exec(""),
      exec(
        JSON.stringify({
          status: "rejected",
          request: REQUEST,
          path: "spec.json:/root",
          reason: "bad",
        }),
      ),
    ]);
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
    expect(adb.getExecutedCommands().some((command) => command.includes("--es label"))).toBe(false);
  });

  test("gives up at the deadline, says the save may have landed, and still removes its files", async () => {
    adb.setCommandResponse("cat '", exec(""));
    await expect(viewer.importBundle(0, new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
      "may still have saved the prototype",
    );
    expect(timer.getSleepCallCount()).toBe(1000 / PROTOVIEWER_RESULT_POLL_MS);
    expect(adb.wasCommandExecuted(`shell rm -f '${ROOT}/results/${REQUEST}.json'`)).toBe(true);
  });

  test("a cancelled call still removes its pushed bundle", async () => {
    adb.setThrowOnAbortedSignal();
    const controller = new AbortController();
    adb.setCommandResponse("cat '", exec(""));
    // Cancelled while waiting for the app, after the bundle was pushed.
    adb.abortAfterCommand("cat '", controller);
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 5000, controller.signal),
    ).rejects.toBeDefined();
    const cleanup = adb.getCommandCalls().find((call) => call.command.startsWith("shell rm -f"));
    expect(cleanup?.command).toContain(`${ROOT}/inbox/${REQUEST}.automobile-proto`);
    expect(cleanup?.signal).toBeUndefined();
    expect(cleanup?.timeoutMs).toBe(5000);
  });

  test("an older ProtoViewer without the MCP activity is reported as a missing entry point", async () => {
    adb.setCommandResponse(
      "am start",
      exec(
        "Error type 3\nError: Activity class {dev.jasonpearson.automobile.protoviewer/dev.jasonpearson.automobile.protoviewer.McpActivity} does not exist.",
      ),
    );
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 1000),
    ).rejects.toBeInstanceOf(ProtoViewerEntryPointMissingError);
    expect(adb.wasCommandExecuted("cat '")).toBe(false);
  });

  test("a launch the system dropped fails at once instead of waiting for the deadline", async () => {
    adb.setCommandResponse(
      "am start",
      exec("Warning: Activity not started, its current task has been brought to the front"),
    );
    await expect(viewer.importBundle(0, new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
      "Could not start ProtoViewer",
    );
    expect(adb.wasCommandExecuted("cat '")).toBe(false);
  });

  test("a result for another request is never accepted", async () => {
    adb.setCommandResponse(
      "cat '",
      exec(
        JSON.stringify({
          status: "imported",
          request: "mcp-stale",
          libraryId: LIBRARY_ID,
          label: "x",
        }),
      ),
    );
    await expect(
      viewer.importBundle(0, new Uint8Array([1]), undefined, 1000),
    ).rejects.toBeInstanceOf(ActionableError);
  });

  test("a malformed result is an error, while extra fields from a newer app are ignored", async () => {
    adb.setCommandResponse("cat '", exec(JSON.stringify({ status: "imported", request: REQUEST })));
    await expect(viewer.importBundle(0, new Uint8Array([1]), undefined, 1000)).rejects.toThrow(
      "unexpected result",
    );
    adb.setCommandResponse(
      "cat '",
      exec(
        JSON.stringify({
          status: "opened",
          request: "mcp-fake-1",
          libraryId: LIBRARY_ID,
          label: "x",
          code: 7,
        }),
      ),
    );
    expect((await viewer.open(0, LIBRARY_ID, 1000)).status).toBe("opened");
  });

  test("open starts the guarded activity with the library id for the given user", async () => {
    adb.setCommandResponse(
      "cat '",
      exec(
        JSON.stringify({
          status: "opened",
          request: REQUEST,
          libraryId: LIBRARY_ID,
          label: "Demo",
        }),
      ),
    );
    const result = await viewer.open(10, LIBRARY_ID, 5000);
    expect(result.status).toBe("opened");
    const root10 = `/storage/emulated/10/Android/data/${PACKAGE}/files/mcp`;
    expect(adb.getExecutedCommands()).toEqual([
      `shell am start -W --activity-multiple-task --user 10 -n ${PACKAGE}/.McpActivity -a ${PACKAGE}.mcp.OPEN --es request ${REQUEST} --es libraryId '${LIBRARY_ID}'`,
      `shell cat '${root10}/results/${REQUEST}.json' 2>/dev/null`,
      `shell rm -f '${root10}/results/${REQUEST}.json'`,
    ]);
  });
});
