import { createExecResult } from "../../../src/utils/execResult";
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { SimulatorHighlights } from "../../../src/features/debug/SimulatorHighlights";
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
    return child as unknown as ChildProcess;
  }
}
function setup() {
  const executor = new Executor();
  const client = new SimulatorHighlights(device, {
    executor,
    timer: executor.timer,
    resolveHelper: async () => "/helper",
  });
  return { executor, client };
}
async function spawned() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("SimulatorHighlights", () => {
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
});
