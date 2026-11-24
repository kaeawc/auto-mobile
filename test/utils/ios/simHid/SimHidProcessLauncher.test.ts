import { describe, expect, test } from "bun:test";
import { DefaultSimHidProcessLauncher } from "../../../../src/utils/ios/simHid/SimHidProcessLauncher";
import { FakeChildProcess } from "../../../fakes/FakeChildProcess";
import { FakeTimer } from "../../../fakes/FakeTimer";

const SIM = "11111111-2222-3333-4444-555555555555";

function setup() {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const spawned: Array<{ file: string; args: string[]; developerDir?: string }> = [];
  const launcher = new DefaultSimHidProcessLauncher(
    {
      spawn: (file, args, options) => {
        spawned.push({ file, args, developerDir: options?.env?.DEVELOPER_DIR });
        return child;
      },
    },
    timer,
    1000,
    500,
  );
  const launch = () =>
    launcher.launch({
      helperPath: "/cache/sim-hid-helper",
      deviceId: SIM,
      env: { DEVELOPER_DIR: "/X" },
    });
  return { timer, child, spawned, launch };
}

describe("DefaultSimHidProcessLauncher", () => {
  test("resolves after the ready line and frames later lines", async () => {
    const { child, spawned, launch } = setup();
    const ready = launch();
    child.stdout.push("diagnostic noise\n");
    child.stdout.push('{"event":"ready","initMs":210.5}\n');
    const handle = await ready;
    expect(spawned).toEqual([{ file: "/cache/sim-hid-helper", args: [SIM], developerDir: "/X" }]);
    const line = Promise.withResolvers<string>();
    handle.transport.onLine(line.resolve);
    handle.transport.send('{"id":"1","cmd":"ping"}');
    expect(child.getStdinData().toString()).toBe('{"id":"1","cmd":"ping"}\n');
    child.stdout.push('{"id":"1","ok":true,"sent":false}\n');
    expect(await line.promise).toBe('{"id":"1","ok":true,"sent":false}');
    handle.kill();
    expect(child.killed).toBe(true);
  });

  test("a startup error line rejects with the helper's code", async () => {
    const { child, launch } = setup();
    const ready = launch();
    child.stdout.push(
      '{"event":"error","error":{"code":"device-not-booted","message":"not booted"}}\n',
    );
    await expect(ready).rejects.toThrow("device-not-booted: not booted");
    expect(child.killed).toBe(true);
  });

  test("a helper that never becomes ready times out and is killed", async () => {
    const { child, timer, launch } = setup();
    const ready = launch();
    timer.advanceTime(1000);
    await expect(ready).rejects.toThrow("was not ready within 1000 ms");
    expect(child.killed).toBe(true);
  });

  test("stop() closes stdin and kills only after the grace period", async () => {
    const { child, timer, launch } = setup();
    const ready = launch();
    child.stdout.push('{"event":"ready","initMs":1}\n');
    const handle = await ready;
    handle.stop();
    expect(child.stdin.writableEnded).toBe(true);
    timer.advanceTime(499);
    expect(child.killed).toBe(false);
    timer.advanceTime(1);
    expect(child.killed).toBe(true);
  });

  test("a helper that exits within the grace period is not killed", async () => {
    const { child, timer, launch } = setup();
    const ready = launch();
    child.stdout.push('{"event":"ready","initMs":1}\n');
    const handle = await ready;
    handle.stop();
    // Exit with exitCode still null so only the cleared timer, not kill()'s guard, prevents a kill.
    child.emit("exit", null, null);
    timer.advanceTime(10);
    timer.advanceTime(1000);
    expect(child.killed).toBe(false);
  });
});
