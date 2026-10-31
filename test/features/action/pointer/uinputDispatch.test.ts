import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PointerNotSentError } from "../../../../src/features/action/pointer/instrumentationDispatch";
import type { PointerRequest } from "../../../../src/features/action/pointer/PointerInjector";
import { createInstrumentationDispatch } from "../../../../src/features/action/pointer/instrumentationDispatch";
import {
  createUinputDispatch,
  readAdbUinputGeometry,
  runAdbUinputScript,
  type UinputScriptResult,
} from "../../../../src/features/action/pointer/uinputDispatch";
import type { UinputDisplayGeometry } from "../../../../src/features/action/pointer/uinputPenScript";
import { ActionableError } from "../../../../src/models/ActionableError";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { flushMicrotasks } from "../../../helpers/shutdownStageHarness";

const stroke: PointerRequest = {
  features: { toolType: "stylus", variablePressure: true },
  points: [
    { x: 100, y: 200, pressure: 0.5 },
    { x: 100, y: 232, durationMs: 32, pressure: 1 },
  ],
};

class FakeUinputDevice {
  scripts: Array<{ script: string; timeoutMs: number }> = [];
  geometryReads = 0;
  constructor(
    private geometry: UinputDisplayGeometry | Error = { width: 1080, height: 2400, rotation: 0 },
    private result: UinputScriptResult = { exitCode: 0, stderr: "" },
  ) {}
  dispatch() {
    return createUinputDispatch(new FakeAdbExecutor(), "emulator-5554", {
      readGeometry: async () => {
        this.geometryReads++;
        if (this.geometry instanceof Error) {
          throw this.geometry;
        }
        return this.geometry;
      },
      runScript: async (script, timeoutMs) => {
        this.scripts.push({ script, timeoutMs });
        return this.result;
      },
    });
  }
}

describe("createUinputDispatch (#13105)", () => {
  test("plays the request's script once, with a timeout covering registration and the stroke", async () => {
    const device = new FakeUinputDevice();
    await device.dispatch()(stroke);
    expect(device.scripts).toHaveLength(1);
    expect(device.scripts[0].script.split("\n")[0]).toContain('"command":"register"');
    expect(device.scripts[0].timeoutMs).toBeGreaterThan(4000 + 32);
  });

  test("sends nothing for a secondary display", async () => {
    const device = new FakeUinputDevice();
    const error = await device
      .dispatch()({ ...stroke, displayId: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PointerNotSentError);
    expect(device.geometryReads).toBe(0);
    expect(device.scripts).toEqual([]);
  });

  test("sends nothing when the display geometry cannot be read", async () => {
    const device = new FakeUinputDevice(new Error("wm size failed"));
    const error = await device
      .dispatch()(stroke)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PointerNotSentError);
    expect((error as Error).message).toContain("wm size failed");
    expect(device.scripts).toEqual([]);
  });

  test("a missing uinput tool or an unwritable /dev/uinput means nothing was sent", async () => {
    for (const [result, hint] of [
      [{ exitCode: 127, stderr: "/system/bin/sh: uinput: inaccessible or not found" }, "no uinput"],
      [{ exitCode: 1, stderr: "Failed to open /dev/uinput: Permission denied" }, "adb root"],
    ] as const) {
      const error = await new FakeUinputDevice(undefined, result)
        .dispatch()(stroke)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PointerNotSentError);
      expect((error as Error).message).toContain(hint);
    }
  });

  test("a script the device could not decode was never played", async () => {
    const error = await new FakeUinputDevice(undefined, { exitCode: 97, stderr: "" })
      .dispatch()(stroke)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PointerNotSentError);
    expect((error as Error).message).toContain("decode");
  });

  test("a transport failure after the run started keeps the partial-run advice", async () => {
    const dispatch = createUinputDispatch(new FakeAdbExecutor(), "emulator-5554", {
      readGeometry: async () => ({ width: 1080, height: 2400, rotation: 0 }),
      runScript: async () => {
        throw new Error("device offline");
      },
    });
    const error = await dispatch(stroke).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).not.toBeInstanceOf(PointerNotSentError);
    expect((error as Error).message).toContain("device offline");
    expect((error as Error).message).toContain("Verify state with observe");
  });

  test("any other failure may have played part of the stroke", async () => {
    const error = await new FakeUinputDevice(undefined, {
      exitCode: 1,
      stderr: "Segmentation fault",
    })
      .dispatch()(stroke)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).not.toBeInstanceOf(PointerNotSentError);
    expect((error as Error).message).toContain("Segmentation fault");
  });

  test("a stroke too long for one shell argument is refused before anything is sent", async () => {
    const device = new FakeUinputDevice();
    const long: PointerRequest = {
      ...stroke,
      points: [stroke.points[0], { x: 900, y: 2000, durationMs: 60_000 }],
    };
    const error = await device
      .dispatch()(long)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PointerNotSentError);
    expect(device.scripts).toEqual([]);
  });

  test("a shell that never reports uinput's exit status leaves the outcome unknown", async () => {
    const error = await new FakeUinputDevice(undefined, { exitCode: null, stderr: "" })
      .dispatch()(stroke)
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(PointerNotSentError);
    expect((error as Error).message).toContain("may have played part");
  });
});

describe("runAdbUinputScript", () => {
  test("pipes the script through base64 into uinput and reads the exit marker", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "uinput -",
      createExecResult(
        "Failed to open /dev/uinput: Permission denied\nautomobile-uinput-exit=1\n",
        "",
      ),
    );
    const result = await runAdbUinputScript(adb, '{"id":1}\n', 5000);
    const [command] = adb.getExecutedArgv();
    expect(command[0]).toBe("shell");
    expect(command[1]).toBe(
      `s=$(echo ${Buffer.from('{"id":1}\n').toString("base64")} | base64 -d) || { echo automobile-uinput-exit=97; exit 0; }; ` +
        `printf '%s\\n' "$s" | uinput - 2>&1; echo automobile-uinput-exit=$?`,
    );
    expect(result).toEqual({
      exitCode: 1,
      stderr: "Failed to open /dev/uinput: Permission denied",
    });
  });
});

describe("readAdbUinputGeometry", () => {
  const portrait = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "observe",
      "windowDumps",
      "dumpsys-window-displays-mirror-portrait.txt",
    ),
    "utf8",
  );
  const device = (wmSize: string) => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell wm size", createExecResult(wmSize, ""));
    adb.setCommandResponse("shell dumpsys window displays", createExecResult(portrait, ""));
    return adb;
  };

  test("sizes the pen to a wm size override, the coordinates gestures are resolved in", async () => {
    const adb = device("Physical size: 1080x2400\nOverride size: 720x1600\n");
    expect(await readAdbUinputGeometry(adb)).toEqual({ width: 720, height: 1600, rotation: 0 });
  });

  test("uses the physical size when there is no override", async () => {
    const adb = device("Physical size: 1080x2400\n");
    expect(await readAdbUinputGeometry(adb)).toEqual({ width: 1080, height: 2400, rotation: 0 });
  });

  test("refuses unreadable wm size output instead of guessing", async () => {
    await expect(readAdbUinputGeometry(device("Physical size: garbage\n"))).rejects.toThrow(
      "wm size",
    );
  });
});

describe("uinput dispatch locking (#13105)", () => {
  const geometry = { width: 1080, height: 2400, rotation: 0 };
  const gatedRun = () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runs: string[] = [];
    const deps = (label: string, gate: boolean) => ({
      readGeometry: async () => geometry,
      runScript: async () => {
        runs.push(label);
        if (gate) {
          started.resolve();
          await release.promise;
        }
        return { exitCode: 0, stderr: "" };
      },
    });
    return { started, release, runs, deps };
  };

  test("runs on separate adb clients for one device play one at a time", async () => {
    const gate = gatedRun();
    const first = createUinputDispatch(
      new FakeAdbExecutor(),
      "uinput-same-device",
      gate.deps("first", true),
    )(stroke);
    await gate.started.promise;
    const second = createUinputDispatch(
      new FakeAdbExecutor(),
      "uinput-same-device",
      gate.deps("second", false),
    )(stroke);
    await flushMicrotasks(50);
    expect(gate.runs).toEqual(["first"]);
    gate.release.resolve();
    await Promise.all([first, second]);
    expect(gate.runs).toEqual(["first", "second"]);
  });

  test("different devices do not wait for each other", async () => {
    const gate = gatedRun();
    const first = createUinputDispatch(
      new FakeAdbExecutor(),
      "uinput-device-a",
      gate.deps("first", true),
    )(stroke);
    await gate.started.promise;
    const second = createUinputDispatch(
      new FakeAdbExecutor(),
      "uinput-device-b",
      gate.deps("second", false),
    )(stroke);
    try {
      await flushMicrotasks(50);
      expect(gate.runs).toEqual(["first", "second"]);
    } finally {
      gate.release.resolve();
    }
    await Promise.all([first, second]);
  });

  test("a uinput pen waits for an instrumentation stroke on the same device", async () => {
    const instrumentationStarted = Promise.withResolvers<void>();
    const instrumentationRelease = Promise.withResolvers<void>();
    const adb = new FakeAdbExecutor();
    const executeCommand = adb.executeCommand.bind(adb);
    adb.executeCommand = async (command, options) => {
      const response = executeCommand(command, options);
      instrumentationStarted.resolve();
      await instrumentationRelease.promise;
      return response;
    };
    adb.setCommandResponse(
      "am instrument",
      createExecResult("INSTRUMENTATION_RESULT: success=true\n", ""),
    );
    const gate = gatedRun();
    const instrumentation = createInstrumentationDispatch(adb, "mixed-route-device")(stroke);
    await instrumentationStarted.promise;
    const pen = createUinputDispatch(
      new FakeAdbExecutor(),
      "mixed-route-device",
      gate.deps("pen", false),
    )(stroke);
    await flushMicrotasks(50);
    expect(gate.runs).toEqual([]);
    instrumentationRelease.resolve();
    await Promise.all([instrumentation, pen]);
    expect(gate.runs).toEqual(["pen"]);
  });
});
