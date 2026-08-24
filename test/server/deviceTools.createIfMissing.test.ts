import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  setDeviceToolsDependencies,
  resetDeviceToolsDependencies,
  registerDeviceTools,
  startDeviceSchema,
} from "../../src/server/deviceTools";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import { FakeDeviceProvisioner } from "../fakes/FakeDeviceProvisioner";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";

describe("startDevice --create-if-missing wiring", () => {
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakeMatcher: FakeDeviceMatcher;
  let fakeGate: FakeDeviceCreationGate;
  let fakeProvisioner: FakeDeviceProvisioner;

  beforeEach(() => {
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeMatcher = new FakeDeviceMatcher();
    fakeGate = new FakeDeviceCreationGate(false);
    fakeProvisioner = new FakeDeviceProvisioner();

    // Nothing booted, nothing to match: every run reaches the "no match" branch.
    fakeDeviceUtils.setBootedDevices("ios", []);
    fakeDeviceUtils.setDeviceImages("ios", []);
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", []);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(null);

    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
      deviceMatcherFactory: () => fakeMatcher,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      deviceCreationGateFactory: () => fakeGate,
      deviceProvisionerFactory: () => fakeProvisioner,
    });

    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
  });

  async function callStartDevice(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = ToolRegistry.getTool("startDevice");
    if (!tool) {
      throw new Error("startDevice not registered");
    }
    const result = await tool.handler(args);
    return JSON.parse(
      typeof result === "string" ? result : ((result as any).content?.[0]?.text ?? "{}"),
    );
  }

  it("accepts createIfMissing through the tool schema", () => {
    const parsed = startDeviceSchema.parse({ platform: "ios", createIfMissing: true });
    expect((parsed as Record<string, unknown>).createIfMissing).toBe(true);
  });

  it("does NOT create anything when the gate is off (default)", async () => {
    await expect(callStartDevice({ platform: "ios" })).rejects.toThrow(
      /No ios device matching criteria found/,
    );
    expect(fakeProvisioner.requests).toEqual([]);
    expect(
      fakeDeviceUtils.getExecutedOperations().some((op) => op.startsWith("startDevice:")),
    ).toBe(false);
  });

  it("does NOT create anything when the flag is explicitly false", async () => {
    await expect(callStartDevice({ platform: "ios", createIfMissing: false })).rejects.toThrow(
      /No ios device matching criteria found/,
    );
    expect(fakeProvisioner.requests).toEqual([]);
    // The handler forwards the explicit flag to the gate so precedence is decided there.
    expect(fakeGate.calls).toEqual([false]);
  });

  it("creates and boots an iOS simulator when the gate is on", async () => {
    fakeGate.setAllowed(true);

    const result = await callStartDevice({ platform: "ios", createIfMissing: true });

    expect(fakeProvisioner.requests).toHaveLength(1);
    expect(fakeProvisioner.requests[0].platform).toBe("ios");
    expect(fakeGate.calls).toEqual([true]);
    expect(result.name).toBe("AutoMobile-iPhone-17-abcd1234");
    expect(result.deviceId).toBe("CREATED-UDID");
    expect(result.source).toBe("cold-boot");
    expect(
      fakeDeviceUtils.getExecutedOperations().some((op) => op.startsWith("startDevice:")),
    ).toBe(true);
  });

  it("creates an Android AVD when the gate is on", async () => {
    fakeGate.setAllowed(true);
    fakeProvisioner.setResult({
      platform: "android",
      name: "AutoMobile-android-34-abcd1234",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    });

    const result = await callStartDevice({ platform: "android", createIfMissing: true });

    expect(fakeProvisioner.requests[0].platform).toBe("android");
    expect(result.name).toBe("AutoMobile-android-34-abcd1234");
    expect(result.source).toBe("cold-boot");
  });

  it("forwards the matching criteria to the provisioner", async () => {
    fakeGate.setAllowed(true);

    await callStartDevice({
      platform: "ios",
      createIfMissing: true,
      minOsVersion: "26.0",
      formFactor: "tablet",
      name: "iPad Pro 13-inch (M4)",
    });

    expect(fakeProvisioner.requests[0]).toMatchObject({
      platform: "ios",
      minOsVersion: "26.0",
      formFactor: "tablet",
      name: "iPad Pro 13-inch (M4)",
    });
  });

  it("consults the gate with undefined when the flag is not supplied (env var can decide)", async () => {
    fakeGate.setAllowed(true);

    await callStartDevice({ platform: "ios" });

    expect(fakeGate.calls).toEqual([undefined]);
    expect(fakeProvisioner.requests).toHaveLength(1);
  });
});
