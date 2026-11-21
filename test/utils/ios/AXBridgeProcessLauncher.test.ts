import { expect, test } from "bun:test";
import { DefaultAXBridgeProcessLauncher } from "../../../src/utils/ios/AXBridgeProcessLauncher";
import { DefaultAXBridgePreflight } from "../../../src/utils/ios/AXBridgePreflight";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { createExecResult } from "../../../src/utils/execResult";

function setup() {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const launcher = new DefaultAXBridgeProcessLauncher("/fake/AXBridge", {
    spawn: (file, args, options) => {
      expect(file).toBe("/fake/AXBridge");
      expect(args).toEqual([]);
      expect(options?.env?.SIMULATOR_UDID).toBe("device");
      child.simulateSpawn();
      return child;
    },
  });
  return { launcher, child, timer };
}

test("launcher frames stdio and kills only the returned child", async () => {
  const { launcher, child, timer } = setup();
  const ready = launcher.launch("device");
  timer.advanceTime(0);
  const handle = await ready;
  expect(handle.pid).toBe(child.pid!);
  handle.transport.send('{"id":"a"}');
  expect(child.getStdinData().toString()).toBe('{"id":"a"}\n');
  const response = Promise.withResolvers<string>();
  handle.transport.onLine(response.resolve);
  child.stdout.push('{"id":');
  child.stdout.push('"a","ok":true}\n');
  expect(await response.promise).toBe('{"id":"a","ok":true}');
  handle.kill();
  expect(child.killed).toBe(true);
  timer.advanceTime(0);
  handle.transport.close();
});

test("launch errors become actionable and do not return a handle", async () => {
  const { launcher, child, timer } = setup();
  child.setSpawnError("missing binary");
  const ready = launcher.launch("device");
  timer.advanceTime(0);
  await expect(ready).rejects.toThrow("install AXBridge");
});

test("preflight rejects background and non-macOS sessions without a trust probe", async () => {
  const commands = new FakeHostCommandExecutor();
  commands.setDefaultResponse(createExecResult("Background", ""));
  expect(await new DefaultAXBridgePreflight(commands, "darwin").isAquaSession()).toBe(false);
  commands.setDefaultResponse(createExecResult("Aqua\n", ""));
  expect(await new DefaultAXBridgePreflight(commands, "darwin").isAquaSession()).toBe(true);
  expect(await new DefaultAXBridgePreflight(commands, "linux").isAquaSession()).toBe(false);
});
