import { describe, expect, test } from "bun:test";
import { PrototypeAdbReverseManager } from "../../src/features/prototype/PrototypeAdbReverseManager";
import {
  reverseForPatch,
  reverseForSavedAction,
  reverseLifecycle,
  withReverseReport,
} from "../../src/server/prototypeReverse";
import { subscribePrototypeCleanup } from "../../src/server/prototypeLifecycle";
import type { ExecResult } from "../../src/models";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const spec = (id: string, url: string) => ({
  id,
  root: { type: "box", onTap: [{ type: "request", via: "device", url }] },
});

/** Records adb commands; `reverse --list` answers with the ports in `existing`. */
function fakeAdb(existing: number[] = []) {
  const commands: string[] = [];
  const execResult = (stdout: string): ExecResult => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (text: string) => stdout.includes(text),
  });
  const factory = {
    create: () => ({
      executeCommand: async (command: string) => {
        commands.push(command);
        const listing = existing.map((port) => `host tcp:${port} tcp:${port}`).join("\n");
        return execResult(command === "reverse --list" ? listing : "");
      },
    }),
  };
  return { commands, factory };
}

function setup(existing: number[] = [], android = true) {
  const adb = fakeAdb(existing);
  const reverses = new PrototypeAdbReverseManager();
  const dependencies = {
    reverses,
    adbFactory: adb.factory,
    target: android ? { android: {} } : {},
  };
  return { adb, reverses, dependencies };
}

describe("reverseLifecycle", () => {
  test("a successful android show reverses its port and a dismiss removes it", async () => {
    const { adb, dependencies } = setup();
    const show = { action: "show" as const, spec: spec("p", "http://localhost:8080/") };
    const target = { id: "p" };
    const step = reverseLifecycle(dependencies, device, show, target);
    const report = await step.prepare([undefined, undefined]);
    expect(adb.commands).toEqual(["reverse --list", "reverse tcp:8080 tcp:8080"]);
    expect(step.output(report, true)).toEqual({});
    await step.settle(true, false);
    expect(adb.commands).toHaveLength(2);
    const dismiss = reverseLifecycle(dependencies, device, { action: "dismiss" as const }, target);
    await dismiss.settle(true, true);
    expect(adb.commands.at(-1)).toBe("reverse --remove tcp:8080");
  });

  test("dismiss all removes every reverse of the device", async () => {
    const { adb, dependencies } = setup();
    for (const [id, port] of [
      ["a", 1],
      ["b", 2],
    ] as const) {
      const show = { action: "show" as const, spec: spec(id, `http://localhost:${port}/`) };
      await reverseLifecycle(dependencies, device, show, { id }).prepare([]);
    }
    const all = reverseLifecycle(
      dependencies,
      device,
      { action: "dismiss" as const },
      { all: true },
    );
    await all.settle(true, true);
    expect(adb.commands.filter((c) => c.startsWith("reverse --remove")).sort()).toEqual([
      "reverse --remove tcp:1",
      "reverse --remove tcp:2",
    ]);
  });

  test("a refused show, a failed dismiss and iOS make no adb call", async () => {
    const { adb, dependencies } = setup();
    const show = { action: "show" as const, spec: spec("p", "http://localhost:8080/") };
    const refused = reverseLifecycle(dependencies, device, show, { id: "p" });
    expect(await refused.prepare([{ success: false, error: "no" }])).toBeUndefined();
    await reverseLifecycle(
      dependencies,
      device,
      { action: "dismiss" as const },
      { id: "p" },
    ).settle(false, true);
    const ios = setup([], false);
    await reverseLifecycle(ios.dependencies, device, show, { id: "p" }).prepare([]);
    expect(adb.commands).toEqual([]);
    expect(ios.adb.commands).toEqual([]);
  });

  test("a first show that fails releases what it staged", async () => {
    const { adb, dependencies } = setup();
    const show = { action: "show" as const, spec: spec("p", "http://localhost:8080/") };
    const step = reverseLifecycle(dependencies, device, show, { id: "p" });
    await step.prepare([]);
    expect(dependencies.reverses.ownedPorts(device.deviceId)).toEqual([8080]);
    await step.settle(false, false);
    expect(adb.commands.at(-1)).toBe("reverse --remove tcp:8080");
    expect(dependencies.reverses.ownedPorts(device.deviceId)).toEqual([]);
  });

  describe("a same-id replacement", () => {
    const replace = async () => {
      const harness = setup();
      const first = reverseLifecycle(
        harness.dependencies,
        device,
        { action: "show" as const, spec: spec("p", "http://localhost:1111/") },
        { id: "p" },
      );
      await first.prepare([]);
      await first.settle(true, false);
      const second = reverseLifecycle(
        harness.dependencies,
        device,
        { action: "show" as const, spec: spec("p", "http://localhost:2222/") },
        { id: "p" },
      );
      await second.prepare([]);
      return { ...harness, second };
    };

    test("stages the new ports without dropping the old ones before the send", async () => {
      const { dependencies } = await replace();
      expect(dependencies.reverses.ownedPorts(device.deviceId)).toEqual([1111, 2222]);
    });

    test("a landed replacement releases the ports it no longer needs", async () => {
      const { adb, dependencies, second } = await replace();
      await second.settle(true, true);
      expect(adb.commands.at(-1)).toBe("reverse --remove tcp:1111");
      expect(dependencies.reverses.ownedPorts(device.deviceId)).toEqual([2222]);
    });

    test("a refused replacement keeps the old ports and removes the new ones", async () => {
      const { adb, dependencies, second } = await replace();
      await second.settle(false, true);
      expect(adb.commands.at(-1)).toBe("reverse --remove tcp:2222");
      expect(adb.commands).not.toContain("reverse --remove tcp:1111");
      expect(dependencies.reverses.ownedPorts(device.deviceId)).toEqual([1111]);
    });

    test("an exception before dispatch does the same, and a settled call is not undone twice", async () => {
      const { adb, dependencies, second } = await replace();
      await second.abandon(false);
      expect(dependencies.reverses.ownedPorts(device.deviceId)).toEqual([1111]);
      const removals = adb.commands.filter((c) => c.startsWith("reverse --remove"));
      expect(removals).toEqual(["reverse --remove tcp:2222"]);
      await second.abandon(false);
      await second.settle(false, true);
      expect(adb.commands.filter((c) => c.startsWith("reverse --remove"))).toEqual(removals);
    });

    test("an exception after dispatch keeps the new claims and drops the old", async () => {
      const { dependencies, second } = await replace();
      await second.abandon(true);
      expect(dependencies.reverses.ownedPorts(device.deviceId)).toEqual([2222]);
    });

    test("a port the replacement shares with the old spec survives a refusal", async () => {
      const { adb, dependencies } = setup();
      const url = "http://localhost:1111/";
      const first = reverseLifecycle(
        dependencies,
        device,
        { action: "show" as const, spec: spec("p", url) },
        { id: "p" },
      );
      await first.prepare([]);
      await first.settle(true, false);
      const again = reverseLifecycle(
        dependencies,
        device,
        { action: "show" as const, spec: spec("p", url) },
        { id: "p" },
      );
      await again.prepare([]);
      await again.settle(false, true);
      expect(adb.commands.filter((c) => c.startsWith("reverse --remove"))).toEqual([]);
      expect(dependencies.reverses.ownedPorts(device.deviceId)).toEqual([1111]);
    });
  });

  test("output reports unreversible urls only for a successful show", async () => {
    const { dependencies } = setup();
    const url = "http://localhost:{state:port}/";
    const step = reverseLifecycle(
      dependencies,
      device,
      { action: "show" as const, spec: spec("p", url) },
      { id: "p" },
    );
    const report = await step.prepare([]);
    expect(step.output(report, true).unreversiblePorts).toMatchObject([{ prototypeId: "p", url }]);
    expect(step.output(report, false)).toEqual({});
  });
});

describe("saved and patched prototypes", () => {
  test("save reverses under a saved claim and deleteSaved removes it", async () => {
    const { adb, dependencies } = setup();
    await reverseForSavedAction(dependencies, device, {
      action: "save",
      spec: spec("p", "http://127.0.0.1:9000/"),
    });
    expect(adb.commands).toContain("reverse tcp:9000 tcp:9000");
    await reverseForSavedAction(dependencies, device, { action: "deleteSaved", id: "p" });
    expect(adb.commands.at(-1)).toBe("reverse --remove tcp:9000");
  });

  test("a saved claim and a shown prototype of one id share the port", async () => {
    const { adb, dependencies } = setup();
    const url = "http://localhost:8080/";
    await reverseForSavedAction(dependencies, device, {
      action: "save",
      spec: spec("p", url),
    });
    await reverseLifecycle(
      dependencies,
      device,
      { action: "show", spec: spec("p", url) },
      { id: "p" },
    ).prepare([]);
    await dependencies.reverses.release(device.deviceId, "p");
    expect(adb.commands.filter((c) => c.startsWith("reverse --remove"))).toEqual([]);
  });

  test("patch re-syncs to the patched spec, adding and dropping ports, and never refuses", async () => {
    const { adb, dependencies } = setup();
    expect(await reverseForPatch(dependencies, device, "p", spec("p", "http://localhost:1/"))).toBe(
      undefined,
    );
    await reverseForPatch(dependencies, device, "p", spec("p", "http://localhost:2/"));
    expect(adb.commands).toContain("reverse --remove tcp:1");
    expect(adb.commands).toContain("reverse tcp:2 tcp:2");
  });

  test("an existing reverse is never removed by dismiss", async () => {
    const { adb, dependencies } = setup([8080]);
    const step = reverseLifecycle(
      dependencies,
      device,
      { action: "show", spec: spec("p", "http://localhost:8080/") },
      { id: "p" },
    );
    await step.prepare([]);
    await step.settle(true, true);
    await reverseLifecycle(dependencies, device, { action: "dismiss" }, { id: "p" }).settle(
      true,
      true,
    );
    expect(adb.commands).toEqual(["reverse --list"]);
  });
});

describe("withReverseReport", () => {
  test("adds fields to a successful output only", () => {
    const report = {
      unreversiblePorts: [],
      reverseFailures: [{ prototypeId: "p", port: 1, error: "x" }],
    };
    expect(withReverseReport({ success: true }, report)).toEqual({
      success: true,
      reverseFailures: report.reverseFailures,
    });
    expect(withReverseReport({ success: false }, report)).toEqual({ success: false });
  });
});

describe("prototype cleanup lifecycle", () => {
  test("device removal and unbinding remove the reverses the host created", async () => {
    const { adb, reverses, dependencies } = setup();
    let removal: (id: string) => void = () => {};
    let unbound: (id: string) => void = () => {};
    const released: string[] = [];
    const events = {
      releaseDevice: (id: string) => {
        released.push(id);
      },
      releaseSession: () => {},
    };
    subscribePrototypeCleanup(
      {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: (listener) => {
          removal = listener;
          return () => {};
        },
        subscribeDeviceUnbound: (listener) => {
          unbound = listener;
          return () => {};
        },
      },
      events,
      reverses,
    );
    const show = (id: string, port: number) =>
      reverseLifecycle(
        dependencies,
        device,
        { action: "show", spec: spec(id, `http://localhost:${port}/`) },
        { id },
      ).prepare([]);
    await show("a", 1);
    removal(device.deviceId);
    await reverses.releaseAll(device.deviceId);
    expect(adb.commands).toContain("reverse --remove tcp:1");
    await show("b", 2);
    unbound(device.deviceId);
    await reverses.releaseAll(device.deviceId);
    expect(adb.commands).toContain("reverse --remove tcp:2");
    expect(released).toEqual([device.deviceId, device.deviceId]);
  });
});
