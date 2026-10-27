import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
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

const hover: PointerRequest = {
  features: { toolType: "stylus", hover: true },
  points: [
    { x: 10, y: 20, distance: 0.4 },
    { x: 30, y: 40, durationMs: 120, distance: 0.1 },
  ],
};
const result = (lines: string[]) => createExecResult(lines.join("\n"), "");

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
    await createInstrumentationDispatch(adb)(request);
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

  test("an am without --no-restart says it needs Android 13", async () => {
    await expect(run(result(["Error: Unknown option: --no-restart"]))).rejects.toThrow(
      /Android 13 or newer. No input was sent/,
    );
  });

  test("a crash or silence leaves the outcome unknown and says to verify", async () => {
    for (const output of ["Process crashed.", ""]) {
      const error = await run(result([output])).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ActionableError);
      expect((error as Error).message).toContain("may have partially run");
    }
  });
});
