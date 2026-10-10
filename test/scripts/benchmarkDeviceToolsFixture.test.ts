import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import cp from "node:child_process";
import {
  installDeviceToolFixture,
  type DeviceToolFixtureName,
  type ToolFixture,
} from "../../scripts/benchmark-device-tools-fixture";
import { registerAppTools } from "../../src/server/appTools";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = {
  name: "benchmark-mock-device",
  platform: "android",
  deviceId: "benchmark-001",
  source: "local",
};

type Envelope = {
  isError?: boolean;
  content?: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
};

const NAMES: DeviceToolFixtureName[] = [
  "observe",
  "pressButton",
  "tapOn",
  "launchApp",
  "installApp",
];

describe("device tool benchmark fixtures (#11375)", () => {
  const fixtures = new Map<DeviceToolFixtureName, ToolFixture>();
  const spawns = [
    spyOn(cp, "spawn").mockImplementation(() => {
      throw new Error("benchmark fixture spawned a process");
    }),
    spyOn(cp, "spawnSync").mockImplementation(() => {
      throw new Error("benchmark fixture spawned a process");
    }),
    spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("benchmark fixture spawned a process");
    }),
    spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("benchmark fixture spawned a process");
    }),
  ];

  beforeAll(async () => {
    registerObserveTools();
    registerInteractionTools();
    registerAppTools();
    // The tapOn fixture builds a migrated in-memory navigation database, which is slow for a test.
    for (const name of NAMES) {
      fixtures.set(name, await installDeviceToolFixture(name));
    }
  });
  afterAll(async () => {
    for (const fixture of fixtures.values()) {
      await fixture.dispose();
    }
    for (const spy of spawns) {
      spy.mockRestore();
    }
  });

  const call = async (name: DeviceToolFixtureName) => {
    const tool = ToolRegistry.getTool(name)!;
    return (await tool.deviceAwareHandler!(device, fixtures.get(name)!.args!)) as Envelope;
  };

  test.each(NAMES)("%s succeeds against fakes without spawning a process", async (name) => {
    const response = await call(name);
    expect(response.isError).toBeUndefined();
    expect(response.content?.[0]?.text).toBeTruthy();
  });

  test("observe serves the captured Android home hierarchy", async () => {
    const response = await call("observe");
    expect(JSON.stringify(response.structuredContent)).toContain("com.google.android");
  });

  test("tapOn resolves a node of the captured hierarchy and taps it", async () => {
    const response = await call("tapOn");
    expect(response.structuredContent).toMatchObject({ success: true, action: "tap" });
  });

  test("launchApp and installApp report the mock package", async () => {
    expect(await call("launchApp")).toMatchObject({
      structuredContent: { success: true, packageName: "com.mock.app" },
    });
    expect((await call("installApp")).content?.[0]?.text).toContain("/benchmark/mock-app.apk");
  });
});
