import { createExecResult } from "../../../src/utils/execResult";
import { describe, expect, test, spyOn } from "bun:test";
import { logger } from "../../../src/utils/logger";
import type { ChildProcess } from "node:child_process";
import {
  resolveHighlightSourceScale,
  SimulatorHighlights,
} from "../../../src/features/debug/SimulatorHighlights";
import type { ScreenScaleMetadata } from "../../../src/models/ScreenScaleMetadata";
import { DefaultHostCommandExecutor } from "../../../src/utils/HostCommandExecutor";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, HighlightShape } from "../../../src/models";

const device: BootedDevice = {
  deviceId: "08F74D1C-D105-45E4-96B0-37C66E002722",
  platform: "ios",
  name: "iPhone",
};
const shape: HighlightShape = {
  type: "circle",
  bounds: { x: 1, y: 2, width: 20, height: 30, sourceWidth: 100, sourceHeight: 200 },
};
class Executor extends DefaultHostCommandExecutor {
  readonly timer = new FakeTimer();
  readonly children: FakeChildProcess[] = [];
  args: string[] = [];
  supportsHighlight = true;
  override async executeCommand() {
    return createExecResult(
      "help",
      this.supportsHighlight
        ? "capture-capability: simulator-highlights\n"
        : "capture-capability: encoded-video-h264\n",
    );
  }
  override spawn(_file: string, args: string[]): ChildProcess {
    this.args = args;
    const child = new FakeChildProcess(this.timer);
    this.children.push(child);
    return child;
  }
}
function setup(screenScale?: () => ScreenScaleMetadata | null) {
  const executor = new Executor();
  const client = new SimulatorHighlights(device, {
    executor,
    timer: executor.timer,
    resolveHelper: async () => "/helper",
    screenScale,
  });
  return { executor, client };
}
// A 3x device whose screen is 200x300 pt and whose screenshot is 600x900 px (#17354).
const threeX: ScreenScaleMetadata = { nativeScale: 3, pixelWidth: 600, pixelHeight: 900 };
const boundsWithSource = (sourceWidth: number, sourceHeight: number) => ({
  x: 1,
  y: 2,
  width: 20,
  height: 30,
  sourceWidth,
  sourceHeight,
});
async function spawned() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("resolveHighlightSourceScale", () => {
  test("reads a screenshot-pixel source as the device scale", () => {
    expect(resolveHighlightSourceScale(boundsWithSource(600, 900), threeX)).toBe(3);
  });
  test("reads a point source as one unit per point", () => {
    expect(resolveHighlightSourceScale(boundsWithSource(200, 300), threeX)).toBe(1);
  });
  test("matches either orientation and one unit of rounding", () => {
    expect(resolveHighlightSourceScale(boundsWithSource(901, 599), threeX)).toBe(3);
    expect(resolveHighlightSourceScale(boundsWithSource(300, 200), threeX)).toBe(1);
  });
  test("keeps a fractional native scale as reported", () => {
    const zoomed = { nativeScale: 2.88, pixelWidth: 1080, pixelHeight: 2340 };
    expect(resolveHighlightSourceScale(boundsWithSource(1080, 2340), zoomed)).toBe(2.88);
    expect(resolveHighlightSourceScale(boundsWithSource(375, 813), zoomed)).toBe(1);
  });
  test("leaves the scale unset when it cannot tell", () => {
    expect(resolveHighlightSourceScale(boundsWithSource(600, 900), null)).toBeUndefined();
    expect(resolveHighlightSourceScale(boundsWithSource(1000, 1000), threeX)).toBeUndefined();
    expect(
      resolveHighlightSourceScale({ x: 1, y: 2, width: 20, height: 30 }, threeX),
    ).toBeUndefined();
  });
  test("never overrides a scale the bounds already carry", () => {
    expect(
      resolveHighlightSourceScale({ ...boundsWithSource(600, 900), sourceScale: 1 }, threeX),
    ).toBeUndefined();
  });
});

describe("SimulatorHighlights", () => {
  test("warns on helper resolution failure and preserves its typed result", async () => {
    const failure = new Error("helper unavailable");
    const client = new SimulatorHighlights(device, {
      timer: new FakeTimer(),
      resolveHelper: async () => {
        throw failure;
      },
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await client.requestAddHighlight("failed", shape)).toEqual({
        success: false,
        error: "Error: helper unavailable",
      });
      expect(warn).toHaveBeenCalledWith(
        "[SimulatorHighlights] Failed to send highlight: helper unavailable",
        failure,
      );
    } finally {
      warn.mockRestore();
    }
  });
  test("old pinned helpers use the SDK without sending unsupported flags", async () => {
    const executor = new Executor();
    executor.supportsHighlight = false;
    const calls: unknown[] = [];
    const client = new SimulatorHighlights(device, {
      executor,
      timer: executor.timer,
      resolveHelper: async () => "/old-helper",
      fallback: () => ({
        requestAddHighlight: async (...args) => {
          calls.push(args);
          return { success: true };
        },
      }),
    });
    expect(await client.requestAddHighlight("legacy", shape, 100)).toEqual({ success: true });
    expect(calls).toEqual([["legacy", shape, 100]]);
    expect(executor.children).toHaveLength(0);
  });
  test("waits for a complete native acknowledgement and preserves shape argv", async () => {
    const { client, executor } = setup();
    const pending = client.requestAddHighlight("a", shape);
    await spawned();
    const child = executor.children[0];
    child.stdout.emit(
      "data",
      Buffer.from(
        '{"requestId":' + JSON.stringify(JSON.parse(executor.args[3]).requestId) + ',"success":',
      ),
    );
    child.stdout.emit("data", Buffer.from("true}\n"));
    expect(await pending).toEqual({ success: true });
    expect(JSON.parse(executor.args[3])).toMatchObject({ id: "a", shape });
    child.emit("exit", 0);
  });
  for (const invalid of ["not json\n", '{"requestId":1,"success":true}\n', "x".repeat(65537)]) {
    test(`terminates invalid acknowledgement hosts (${invalid.length} bytes)`, async () => {
      const { client, executor } = setup();
      const first = client.requestAddHighlight("first", shape);
      const second = client.requestAddHighlight("second", shape);
      await spawned();
      const child = executor.children[0];
      child.stdout.emit("data", Buffer.from(invalid));
      expect((await first).success).toBe(false);
      expect((await second).success).toBe(false);
      expect(child.killed).toBe(true);
      const replacement = client.requestAddHighlight("replacement", shape);
      await spawned();
      expect(executor.children).toHaveLength(2);
      // A delayed exit from the failed host must not evict its replacement.
      child.emit("exit", 1);
      executor.children[1].stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            requestId: JSON.parse(executor.args[3]).requestId,
            success: true,
          }) + "\n",
        ),
      );
      expect(await replacement).toEqual({ success: true });
      executor.children[1].emit("exit", 0);
    });
  }
  test("reports a native permission failure without success", async () => {
    const { client, executor } = setup();
    const pending = client.requestAddHighlight("b", shape);
    await spawned();
    const child = executor.children[0];
    child.stderr.emit("data", Buffer.from("Accessibility permission required"));
    child.emit("exit", 1);
    expect((await pending).error).toContain("Accessibility permission required");
  });
  test("times out without terminating a host used by capture", async () => {
    const { client, executor } = setup();
    const pending = client.requestAddHighlight("c", shape, 10);
    await spawned();
    executor.timer.advanceTime(10);
    expect((await pending).success).toBe(false);
    expect(executor.children[0].killed).toBe(false);
  });
  test("reuses the host and correlates acknowledgements", async () => {
    const { client, executor } = setup();
    const first = client.requestAddHighlight("replace", shape);
    await spawned();
    const request = JSON.parse(executor.args[3]);
    executor.children[0].stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ requestId: request.requestId, success: true }) + "\n"),
    );
    await first;
    const second = client.requestAddHighlight("replace", shape);
    await spawned();
    expect(executor.children).toHaveLength(1);
    const sent = JSON.parse(executor.children[0].getStdinData().toString());
    executor.children[0].stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ requestId: sent.requestId, success: true }) + "\n"),
    );
    expect((await second).success).toBe(true);
    expect(executor.children[0].killed).toBe(false);
    executor.children[0].emit("exit", 0);
  });
  test("sends the device scale with screenshot-pixel bounds", async () => {
    const { client, executor } = setup(() => threeX);
    void client.requestAddHighlight("px", {
      type: "circle",
      bounds: boundsWithSource(600, 900),
    });
    await spawned();
    expect(JSON.parse(executor.args[3]).shape.bounds).toEqual({
      ...boundsWithSource(600, 900),
      sourceScale: 3,
    });
    executor.children[0].emit("exit", 0);
  });
  test("keeps the bounds unchanged when the scale is unknown", async () => {
    const { client, executor } = setup(() => null);
    void client.requestAddHighlight("legacy", shape);
    await spawned();
    expect(JSON.parse(executor.args[3]).shape).toEqual(shape);
    expect(JSON.parse(executor.args[3]).shape.bounds).not.toHaveProperty("sourceScale");
    executor.children[0].emit("exit", 0);
  });
  test("forwards a scale the selector path already set", async () => {
    const { client, executor } = setup(() => threeX);
    const points: HighlightShape = {
      type: "circle",
      bounds: { ...boundsWithSource(600, 900), sourceScale: 1 },
    };
    void client.requestAddHighlight("selector", points);
    await spawned();
    expect(JSON.parse(executor.args[3]).shape).toEqual(points);
    executor.children[0].emit("exit", 0);
  });
});
