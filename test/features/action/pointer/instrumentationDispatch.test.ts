import { describe, expect, test } from "bun:test";
import type { AdbExecuteOptions } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  POINTER_INSTRUMENTATION_COMPONENT,
  createInstrumentationDispatch,
  encodePointerRequest,
  parsePointerInstrumentationOutput,
  pointerInstrumentationCommand,
} from "../../../../src/features/action/pointer/instrumentationDispatch";
import type { PointerRequest } from "../../../../src/features/action/pointer/PointerInjector";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { flushMicrotasks } from "../../../helpers/shutdownStageHarness";

const hover: PointerRequest = {
  features: { toolType: "stylus", hover: true },
  points: [
    { x: 10, y: 20, distance: 0.4 },
    { x: 30, y: 40, durationMs: 120, distance: 0.1 },
  ],
};
const result = (lines: string[]) => createExecResult(lines.join("\n"), "");

const success = result(["INSTRUMENTATION_RESULT: success=true"]);
const refusal = (injected = 0, error = "the system refused HOVER_ENTER at 0 ms") =>
  result([
    "INSTRUMENTATION_RESULT: success=false",
    `INSTRUMENTATION_RESULT: injected=${injected}`,
    `INSTRUMENTATION_RESULT: error=${error}`,
  ]);

const DEVICE = "emulator-5554";

class GatedAdbExecutor extends FakeAdbExecutor {
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  private gated = false;

  override async executeCommand(command: string, options?: AdbExecuteOptions) {
    const response = super.executeCommand(command, options);
    if (command.includes("am instrument") && !this.gated) {
      this.gated = true;
      this.started.resolve();
      await this.release.promise;
    }
    return response;
  }
}

describe("encodePointerRequest", () => {
  test("is base64 JSON with the version, tool and points", () => {
    const decoded = JSON.parse(Buffer.from(encodePointerRequest(hover), "base64").toString("utf8"));
    expect(decoded).toEqual({
      version: 1,
      tool: "stylus",
      hover: true,
      buttons: 0,
      displayId: 0,
      points: [
        { x: 10, y: 20, distance: 0.4 },
        { x: 30, y: 40, durationMs: 120, distance: 0.1 },
      ],
    });
  });

  test("sends the 200 ms default explicitly for points that give no duration", () => {
    const decoded = JSON.parse(
      Buffer.from(
        encodePointerRequest({
          features: { toolType: "mouse", hover: true },
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3, durationMs: 40 },
          ],
        }),
        "base64",
      ).toString("utf8"),
    );
    expect(decoded.points.map((point: { durationMs?: number }) => point.durationMs)).toEqual([
      undefined,
      200,
      40,
    ]);
  });

  test("carries stroke pressure, tilt, orientation and buttons", () => {
    const stroke: PointerRequest = {
      features: { toolType: "stylus", variablePressure: true },
      buttons: 32,
      points: [{ x: 1, y: 2, pressure: 0.3, tilt: 0.5, orientation: -1 }],
    };
    const decoded = JSON.parse(
      Buffer.from(encodePointerRequest(stroke), "base64").toString("utf8"),
    );
    expect(decoded).toMatchObject({
      hover: false,
      buttons: 32,
      points: [{ pressure: 0.3, tilt: 0.5, orientation: -1 }],
    });
  });

  test("the command is one shell-safe token per argument", () => {
    const command = pointerInstrumentationCommand(hover);
    expect(command).toMatch(
      /^shell am instrument -w -r --no-restart -e request [A-Za-z0-9+/=]+ \S+$/,
    );
    expect(command.endsWith(POINTER_INSTRUMENTATION_COMPONENT)).toBe(true);
  });
});

describe("parsePointerInstrumentationOutput", () => {
  test("reads a success", () => {
    expect(
      parsePointerInstrumentationOutput(
        "INSTRUMENTATION_RESULT: success=true\nINSTRUMENTATION_RESULT: injected=12\nINSTRUMENTATION_RESULT: elapsedMs=250\nINSTRUMENTATION_CODE: -1",
      ),
    ).toEqual({ success: true, injected: 12, elapsedMs: 250 });
  });

  test("reads a refusal with its error", () => {
    expect(
      parsePointerInstrumentationOutput(
        "INSTRUMENTATION_RESULT: success=false\r\nINSTRUMENTATION_RESULT: error=the system refused MOVE\r\nINSTRUMENTATION_RESULT: injected=2",
      ),
    ).toEqual({ success: false, error: "the system refused MOVE", injected: 2, elapsedMs: 0 });
  });

  test("anything without a success flag is no report", () => {
    for (const output of [
      "",
      "Error: Unable to find instrumentation",
      "INSTRUMENTATION_CODE: -1",
    ]) {
      expect(parsePointerInstrumentationOutput(output)).toBeUndefined();
    }
  });
});

describe("createInstrumentationDispatch", () => {
  const run = async (response: ReturnType<typeof createExecResult>, request = hover) => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("am instrument", response);
    await createInstrumentationDispatch(adb, DEVICE)(request);
    return adb;
  };

  test("starts the instrumentation with the request and resolves on success", async () => {
    const adb = await run(result(["INSTRUMENTATION_RESULT: success=true"]));
    const [command] = adb.getExecutedCommands();
    expect(command).toContain("am instrument -w -r --no-restart -e request");
    expect(command).toContain(POINTER_INSTRUMENTATION_COMPONENT);
  });

  test("a refusal the instrumentation reports becomes an actionable error with the count", async () => {
    await expect(
      run(
        result([
          "INSTRUMENTATION_RESULT: success=false",
          "INSTRUMENTATION_RESULT: error=the system refused HOVER_MOVE at 16 ms",
          "INSTRUMENTATION_RESULT: injected=1",
        ]),
      ),
    ).rejects.toThrow(/after 1 event: the system refused HOVER_MOVE/);
  });

  test("an APK without the instrumentation says to update CtrlProxy", async () => {
    await expect(
      run(
        result([
          "INSTRUMENTATION_FAILED: Unable to find instrumentation info for: ComponentInfo{x}",
        ]),
      ),
    ).rejects.toThrow(
      /does not include the pointer instrumentation; update CtrlProxy. No input was sent/,
    );
  });

  test("an am without --no-restart says it needs Android 12", async () => {
    await expect(run(result(["Error: Unknown option: --no-restart"]))).rejects.toThrow(
      /Android 12 or newer. No input was sent/,
    );
  });

  test("a crash or silence leaves the outcome unknown and says to verify", async () => {
    for (const output of ["Process crashed.", ""]) {
      await expect(run(result([output]))).rejects.toThrow("may have partially run");
    }
  });
  test("a zero-event refusal cancels at rounded first-point coordinates and retries once", async () => {
    const adb = new FakeAdbExecutor();
    const request = { ...hover, points: [{ x: 500.4, y: 999.6 }] };
    adb.setCommandResponseSequence("am instrument", [refusal(), success]);
    await createInstrumentationDispatch(adb, DEVICE)(request);
    expect(adb.getExecutedCommands()).toEqual([
      pointerInstrumentationCommand(request),
      "shell input stylus motionevent CANCEL 500 1000",
      pointerInstrumentationCommand(request),
    ]);
    expect(adb.getCommandCalls()[1].timeoutMs).toBe(5000);
  });

  test("persistent refusal stops after exactly two instrumentation runs", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("am instrument", refusal());
    await expect(createInstrumentationDispatch(adb, DEVICE)(hover)).rejects.toThrow(
      "the system refused HOVER_ENTER at 0 ms",
    );
    expect(adb.getExecutedCommands()).toEqual([
      pointerInstrumentationCommand(hover),
      "shell input stylus motionevent CANCEL 10 20",
      pointerInstrumentationCommand(hover),
    ]);
  });

  test("a refusal after two injected events never cancels or retries", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("am instrument", refusal(2));
    await expect(createInstrumentationDispatch(adb, DEVICE)(hover)).rejects.toThrow(
      "after 2 events",
    );
    expect(adb.getExecutedCommands()).toEqual([pointerInstrumentationCommand(hover)]);
  });

  test("a zero-event failure without a refusal never cancels or retries", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("am instrument", refusal(0, "invalid request"));
    await expect(createInstrumentationDispatch(adb, DEVICE)(hover)).rejects.toThrow(
      "invalid request",
    );
    expect(adb.getExecutedCommands()).toEqual([pointerInstrumentationCommand(hover)]);
  });

  test("a failed CANCEL still allows the one retry to succeed", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("am instrument", [refusal(), success]);
    adb.setCommandError("motionevent CANCEL", new Error("CANCEL unavailable"));
    await createInstrumentationDispatch(adb, DEVICE)(hover);
    expect(adb.getExecutedCommands()).toEqual([
      pointerInstrumentationCommand(hover),
      "shell input stylus motionevent CANCEL 10 20",
      pointerInstrumentationCommand(hover),
    ]);
  });

  test.each([
    ["null", "is not enabled; re-enable it before retrying."],
    ["other/service:dev.jasonpearson.automobile.ctrlproxy/.CtrlProxyService", "is still enabled."],
  ])("a crash reports accessibility service state from %s", async (state, note) => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "am instrument",
      result(["INSTRUMENTATION_RESULT: shortMsg=Process crashed."]),
    );
    adb.setCommandResponse("settings get", createExecResult(state, ""));
    const dispatch = createInstrumentationDispatch(adb, DEVICE)(hover);
    await expect(dispatch).rejects.toThrow("may have partially run");
    await expect(dispatch).rejects.toThrow(`CtrlProxy's accessibility service ${note}`);
    expect(adb.getExecutedCommands()).toHaveLength(2);
    expect(adb.getCommandCalls()[1]).toMatchObject({
      command: "shell settings get secure enabled_accessibility_services",
      timeoutMs: 5000,
    });
  });

  test("an unreadable accessibility setting preserves the crash error without a state note", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "am instrument",
      result(["INSTRUMENTATION_RESULT: shortMsg=runner died"]),
    );
    adb.setCommandError("settings get", new Error("settings unavailable"));
    await expect(createInstrumentationDispatch(adb, DEVICE)(hover)).rejects.toThrow(
      /^The pointer instrumentation crashed before reporting a result; the hover or stroke may have partially run\. Verify state with observe before retrying\.$/,
    );
  });

  test("dispatches on separate adb clients for one device run one at a time", async () => {
    // Each tool call builds its own adb client, so the lock must follow the device.
    const firstAdb = new GatedAdbExecutor();
    const secondAdb = new FakeAdbExecutor();
    firstAdb.setCommandResponse("am instrument", success);
    secondAdb.setCommandResponse("am instrument", success);
    const first = createInstrumentationDispatch(firstAdb, "serial-same-device")(hover);
    await firstAdb.started.promise;
    const second = createInstrumentationDispatch(secondAdb, "serial-same-device")(hover);
    await flushMicrotasks(50);
    expect(secondAdb.getExecutedCommands()).toEqual([]);
    firstAdb.release.resolve();
    await Promise.all([first, second]);
    expect(secondAdb.getExecutedCommands()).toEqual([pointerInstrumentationCommand(hover)]);
  });

  test("different devices do not wait for each other", async () => {
    const firstAdb = new GatedAdbExecutor();
    const secondAdb = new FakeAdbExecutor();
    firstAdb.setCommandResponse("am instrument", success);
    secondAdb.setCommandResponse("am instrument", success);
    const first = createInstrumentationDispatch(firstAdb, "serial-device-a")(hover);
    await firstAdb.started.promise;
    const second = createInstrumentationDispatch(secondAdb, "serial-device-b")(hover);
    try {
      await flushMicrotasks(50);
      expect(secondAdb.getExecutedCommands()).toEqual([pointerInstrumentationCommand(hover)]);
    } finally {
      firstAdb.release.resolve();
    }
    await Promise.all([first, second]);
  });

  test("a caller aborted while queued never starts instrumentation", async () => {
    const adb = new GatedAdbExecutor();
    adb.setCommandResponse("am instrument", success);
    const first = createInstrumentationDispatch(adb, DEVICE)(hover);
    await adb.started.promise;
    const controller = new AbortController();
    const queued = createInstrumentationDispatch(adb, DEVICE)(hover, controller.signal);
    controller.abort();
    adb.release.resolve();
    await expect(queued).rejects.toThrow();
    await first;
    expect(adb.getExecutedCommands()).toEqual([pointerInstrumentationCommand(hover)]);
  });

  test("an already-aborted signal never starts instrumentation", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createInstrumentationDispatch(adb, DEVICE)(hover, controller.signal),
    ).rejects.toThrow();
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each(["am instrument", "motionevent CANCEL"])(
    "cancellation after %s skips the retry",
    async (command) => {
      const adb = new FakeAdbExecutor();
      const controller = new AbortController();
      adb.setCommandResponseSequence("am instrument", [refusal(), success]);
      adb.abortAfterCommand(command, controller);
      await expect(
        createInstrumentationDispatch(adb, DEVICE)(hover, controller.signal),
      ).rejects.toThrow();
      expect(
        adb.getExecutedCommands().filter((value) => value.includes("am instrument")),
      ).toHaveLength(1);
      expect(adb.getExecutedCommands()).toHaveLength(command === "am instrument" ? 1 : 2);
    },
  );
});
