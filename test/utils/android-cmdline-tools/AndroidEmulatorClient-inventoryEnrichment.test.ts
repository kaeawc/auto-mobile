import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { createExecResult as execResult } from "../../../src/utils/execResult";
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeTimer } from "../../fakes/FakeTimer";

const createExecResult = (stdout: string) => execResult(stdout, "");
function hermetic(client: AndroidEmulatorClient): AndroidEmulatorClient {
  Object.defineProperty(client, "ensureEmulatorPath", { value: async () => "emulator" });
  return client;
}

const inventory = { coalesceInventoryEnrichment: true, readinessOnly: false };
function fixture() {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  adb.setDevices([
    { name: "ignored", platform: "android", deviceId: "emulator-5554", observedAt: 1 },
  ]);
  adb.setCommandResponse("emu avd name", createExecResult("Pixel_9\nOK"));
  const text = (name: string) =>
    readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
  adb.setCommandResponse(
    "dumpsys SurfaceFlinger --display-id",
    createExecResult(text("fold-surfaceflinger.txt")),
  );
  adb.setCommandResponse(
    "dumpsys display",
    createExecResult(text("fold-open-display-device-info.txt")),
  );
  adb.setCommandResponse(
    "cmd device_state print-states",
    createExecResult(text("fold-states.txt")),
  );
  const clients = Array.from({ length: 4 }, () =>
    hermetic(
      new AndroidEmulatorClient(
        async () => createExecResult("Pixel_9"),
        null,
        timer,
        new FakeAdbClientFactory(adb),
        new FakeAvdConfigReader(),
      ),
    ),
  );
  return { timer, adb, clients };
}

function count(adb: FakeAdbExecutor, command: string) {
  return adb.getExecutedCommands().filter((value) => value === command).length;
}

describe("inventory-only Android enrichment", () => {
  test("four clients share successful names and display commands for 2500ms", async () => {
    const { timer, adb, clients } = fixture();
    await Promise.all(clients.map((client) => client.getBootedDevicesChecked(false, inventory)));
    for (const command of [
      "emu avd name",
      "shell dumpsys SurfaceFlinger --display-id",
      "shell dumpsys display",
      "shell cmd device_state print-states",
    ]) {
      expect(count(adb, command)).toBe(1);
    }
    await clients[0].getBootedDevicesChecked(false, inventory);
    expect(count(adb, "emu avd name")).toBe(1);
    timer.advanceTime(2500);
    await clients[0].getBootedDevicesChecked(false, inventory);
    expect(count(adb, "emu avd name")).toBe(2);
  });

  test("a new device-list observation and a bypass never reuse a previous incarnation", async () => {
    const { adb, clients } = fixture();
    await clients[0].getBootedDevicesChecked(false, inventory);
    adb.setDevices([
      { name: "ignored", platform: "android", deviceId: "emulator-5554", observedAt: 2 },
    ]);
    adb.setCommandResponse("emu avd name", createExecResult("Replacement"));
    expect((await clients[1].getBootedDevicesChecked(false, inventory))[0].name).toBe(
      "Replacement",
    );
    await clients[0].getBootedDevicesChecked(false, { ...inventory, bypassDeviceListCache: true });
    await clients[1].getBootedDevicesChecked(false, inventory);
    expect(count(adb, "emu avd name")).toBe(4);
  });

  test("unknown names and failed displays are not cached", async () => {
    const { adb, clients } = fixture();
    adb.setCommandResponse("emu avd name", createExecResult(""));
    adb.setCommandError("dumpsys display", new Error("busy"));
    await clients[0].getBootedDevicesChecked(false, inventory);
    await clients[1].getBootedDevicesChecked(false, inventory);
    expect(count(adb, "emu avd name")).toBe(2);
    expect(count(adb, "shell dumpsys display")).toBe(2);
  });

  test("readiness and target scans keep probing names", async () => {
    const { adb, clients } = fixture();
    await clients[0].getBootedDevicesChecked(false, inventory);
    await clients[0].getBootedDevicesChecked(false, { readinessOnly: true });
    await clients[0].getBootedDevicesChecked(false, {
      ...inventory,
      targetDeviceId: "emulator-5554",
    });
    expect(count(adb, "emu avd name")).toBe(3);
  });

  test("the name-flight leader can disconnect while a second client completes the same probe", async () => {
    const { timer, adb, clients } = fixture();
    const execute = adb.executeCommand.bind(adb);
    adb.executeCommand = async (command, ...args) => {
      if (command === "emu avd name") {
        const signal = getAbortSignal();
        await timer.sleep(25);
        signal?.throwIfAborted();
      }
      return execute(command, ...args);
    };
    const leader = new AbortController();
    const first = runWithAbortSignal(leader.signal, () =>
      clients[0].getBootedDevicesChecked(false, inventory),
    ).then(
      () => "resolved",
      () => "cancelled",
    );
    const second = clients[1].getBootedDevicesChecked(false, inventory);
    await new Promise<void>((resolve) => setImmediate(resolve));
    leader.abort();
    await timer.advanceTimeAsync(25);
    expect((await second)[0].name).toBe("Pixel_9");
    expect(await first).toBe("cancelled");
    expect(count(adb, "emu avd name")).toBe(1);
  });

  test("inventory AVD listings are shared while ordinary listings stay fresh", async () => {
    const timer = new FakeTimer();
    let calls = 0;
    const exec = async () => {
      calls++;
      return createExecResult("Pixel_9");
    };
    const clients = Array.from({ length: 4 }, () =>
      hermetic(new AndroidEmulatorClient(exec, null, timer, undefined, new FakeAvdConfigReader())),
    );
    const options = { coalesceInventoryEnrichment: true, timeoutMs: 2000 };
    await Promise.all(clients.map((client) => client.listAvds(options)));
    expect(calls).toBe(1);
    await clients[0].listAvds();
    expect(calls).toBe(2);
    timer.advanceTime(2500);
    await clients[0].listAvds(options);
    expect(calls).toBe(3);
  });

  test("a shared listing does not capture the leader's ambient cancellation", async () => {
    const timer = new FakeTimer();
    let calls = 0;
    const exec = async () => {
      calls++;
      const signal = getAbortSignal();
      await timer.sleep(25);
      signal?.throwIfAborted();
      return createExecResult("Pixel_9");
    };
    const client = hermetic(
      new AndroidEmulatorClient(exec, null, timer, undefined, new FakeAvdConfigReader()),
    );
    const leader = new AbortController();
    const options = { coalesceInventoryEnrichment: true, timeoutMs: 2000 };
    const first = runWithAbortSignal(leader.signal, () => client.listAvds(options)).then(
      () => "resolved",
      () => "cancelled",
    );
    const second = client.listAvds(options).then(
      (value) => value,
      () => [],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    leader.abort();
    await timer.advanceTimeAsync(25);
    expect(await second).toHaveLength(1);
    expect(await first).toBe("cancelled");
    expect(calls).toBe(1);
  });
  test("a 2s listAvds waiter leaves the generous shared flight alive for 5s success", async () => {
    const timer = new FakeTimer();
    let calls = 0;
    const client = hermetic(
      new AndroidEmulatorClient(
        async () => {
          calls++;
          await timer.sleep(5_000);
          return createExecResult("Pixel_9");
        },
        null,
        timer,
        undefined,
        new FakeAvdConfigReader(),
      ),
    );
    const short = client.listAvds({ coalesceInventoryEnrichment: true, timeoutMs: 2_000 }).then(
      () => "resolved",
      () => "timeout",
    );
    const patient = client.listAvds({ coalesceInventoryEnrichment: true, timeoutMs: 9_000 }).then(
      (value) => value,
      () => [],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(2_000);
    expect(await short).toBe("timeout");
    await timer.advanceTimeAsync(3_000);
    expect(await patient).toHaveLength(1);
    expect(await client.listAvds({ coalesceInventoryEnrichment: true })).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
