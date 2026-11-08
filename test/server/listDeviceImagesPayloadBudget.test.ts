import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toolJson } from "../helpers/toolResponse";
import { installFakeDeviceToolProviders } from "../helpers/hermeticDeviceTools";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { createListingHandlers } from "../../src/server/deviceToolsListing";
import type { ListDeviceImagesArgs } from "../../src/features/deviceLifecycle/core/inventory";
import {
  DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
  finalizeToolResponse,
  type ObservationArtifactMetadata,
  type ObservationArtifactWriteInput,
  type ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";
import { listDeviceImagesOutputSchema } from "../../src/features/deviceLifecycle/core/toolSchemas";
import {
  HostAudioProbe,
  type CoreAudioHal,
  type RawAudioDevice,
} from "../../src/utils/audio/hostAudio";
import { setHostAudioProbeForTesting } from "../../src/utils/audio/defaultHostAudioProbe";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import {
  createStructuredToolResponse,
  getStructuredPayload,
  stringifyToolResponse,
} from "../../src/utils/toolUtils";
import type { DeviceInfo } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeAvdManager } from "../fakes/FakeAvdManager";

/**
 * Per-image byte budgets for the default response (#17256). 0.0.90 shipped about 2,500 B per
 * iOS image, so a host with more than ~26 simulators spilled past the 64 KiB inline limit.
 */
const IOS_BYTES_PER_IMAGE_BUDGET = 1_000;
const ANDROID_BYTES_PER_IMAGE_BUDGET = 600;

interface CapturedHal {
  defaults: { input: number | null; output: number | null };
  devices: Record<string, RawAudioDevice>;
}

const captured: CapturedHal = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dir, "../fixtures/host-audio/coreaudio-macbook-pro.json"),
    "utf8",
  ),
);

class CapturedHalFake implements CoreAudioHal {
  defaultDeviceId(direction: "input" | "output"): number | undefined {
    return captured.defaults[direction] ?? undefined;
  }

  describe(id: number): RawAudioDevice | undefined {
    return captured.devices[String(id)];
  }
}

class RecordingArtifactWriter implements ObservationArtifactWriter {
  writes: ObservationArtifactWriteInput[] = [];

  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    this.writes.push(input);
    return {
      artifact: {
        path: `/tmp/auto-mobile/${input.tool}.json`,
        format: "json",
        payload: input.payload,
        bytes: 1,
        tool: input.tool,
        resourceUri: `automobile:tool-output/${input.tool}`,
      },
    };
  }
}

const IOS_DEVICE_TYPES = ["iPhone-17-Pro", "iPhone-17", "iPad-Air-11-inch-M4", "iPad-Pro-13-inch"];

/** A realistic simctl inventory: device types times two runtimes, all shut down. */
function iosSimulators(count: number): DeviceInfo[] {
  return Array.from({ length: count }, (_, index) => {
    const deviceType = IOS_DEVICE_TYPES[index % IOS_DEVICE_TYPES.length]!;
    const runtime = index % 2 === 0 ? "iOS-26-0" : "iOS-18-6";
    return {
      name: `${deviceType.replaceAll("-", " ")} ${index}`,
      platform: "ios",
      deviceId: `6F1C2D3E-4A5B-4C6D-8E7F-${String(index).padStart(12, "0")}`,
      isRunning: false,
      state: "Shutdown",
      isAvailable: true,
      runtime: `com.apple.CoreSimulator.SimRuntime.${runtime}`,
      deviceType: `com.apple.CoreSimulator.SimDeviceType.${deviceType}`,
      osVersion: runtime === "iOS-26-0" ? "26.0" : "18.6",
    };
  });
}

function androidImages(count: number): DeviceInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Pixel_9_API_${30 + (index % 6)}_${index}`,
    platform: "android",
    isRunning: false,
    osVersion: "15",
    apiLevel: 30 + (index % 6),
  }));
}

async function listImages(
  devices: DeviceInfo[],
  args: ListDeviceImagesArgs,
): Promise<Record<string, unknown>> {
  setDeviceToolsDependencies({
    deviceManagerFactory: () => new FakeDeviceManager(devices),
    avdManagerFactory: () => new FakeAvdManager(),
  });
  // The bare handler: the registry's delivery path would already spill an oversized result.
  return toolJson(await createListingHandlers().listDeviceImagesHandler(args));
}

function bytesPerImage(payload: Record<string, unknown>): number {
  return (
    Buffer.byteLength(stringifyToolResponse(payload), "utf8") / (payload.images as unknown[]).length
  );
}

function finalized(payload: Record<string, unknown>, writer: RecordingArtifactWriter) {
  const response = finalizeToolResponse(createStructuredToolResponse(payload), {
    name: "listDeviceImages",
    artifactWriter: writer,
    outputSchema: listDeviceImagesOutputSchema,
  });
  return getStructuredPayload<Record<string, unknown>>(response)!;
}

let restoreProviders: () => void;
beforeEach(() => {
  restoreProviders = installFakeDeviceToolProviders();
  AndroidAvdProvenanceCache.resetForTests();
  setHostAudioProbeForTesting(new HostAudioProbe(new CapturedHalFake(), "darwin"));
});
afterEach(() => {
  setHostAudioProbeForTesting(undefined);
  AndroidAvdProvenanceCache.resetForTests();
  resetDeviceToolsDependencies();
  restoreProviders();
});

describe("listDeviceImages payload size (#17256)", () => {
  test("40 iOS simulators with probed host audio fit inline, complete and consistent", async () => {
    const payload = await listImages(iosSimulators(40), { platform: "ios" });
    const writer = new RecordingArtifactWriter();
    const inline = finalized(payload, writer);

    expect(writer.writes).toHaveLength(0);
    expect(Buffer.byteLength(stringifyToolResponse(inline), "utf8")).toBeLessThanOrEqual(
      DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
    );
    expect(inline.count).toBe(40);
    expect((inline.images as unknown[]).length).toBe(40);
    expect(inline.truncated).toBeUndefined();
    expect(inline.configuredInventory).toBeDefined();
    expect(listDeviceImagesOutputSchema.safeParse(inline).success).toBe(true);
  });

  test("average bytes per iOS image stay within budget", async () => {
    const payload = await listImages(iosSimulators(40), { platform: "ios" });
    expect(bytesPerImage(payload)).toBeLessThanOrEqual(IOS_BYTES_PER_IMAGE_BUDGET);
  });

  test("average bytes per Android image stay within budget", async () => {
    const payload = await listImages(androidImages(40), { platform: "android" });
    expect(bytesPerImage(payload)).toBeLessThanOrEqual(ANDROID_BYTES_PER_IMAGE_BUDGET);
  });

  test("host audio capabilities appear once per response, not once per image", async () => {
    const payload = await listImages(iosSimulators(3), { platform: "ios" });
    const text = stringifyToolResponse(payload);

    expect(text.split("ios.simulator.audioInput")).toHaveLength(2);
    const host = payload.host as { capabilities: { id: string; source: string }[] };
    expect(host.capabilities.map((entry) => entry.id)).toEqual([
      "ios.simulator.audioInput",
      "ios.simulator.audioOutput",
      "ios.simulator.audioOutputCapture",
    ]);
    const images = payload.images as Record<string, unknown>[];
    expect(new Set(images.map((image) => image.capabilityProfile))).toEqual(new Set(["p1"]));
    const profiles = payload.capabilityProfiles as Record<string, { capabilities: unknown[] }>;
    expect(Object.keys(profiles)).toEqual(["p1"]);
    expect(images.every((image) => image.capabilityInventory === undefined)).toBe(true);
  });

  test("iOS images omit null guest hardware, display, image and runtime fields", async () => {
    const payload = await listImages(iosSimulators(1), { platform: "ios" });
    const image = (payload.images as Record<string, unknown>[])[0]!;

    for (const key of [
      "configuredRamMb",
      "effectiveRamMb",
      "configuredCpuCores",
      "effectiveCpuCores",
      "display",
      "image",
      "availabilityError",
      "apiLevel",
    ]) {
      expect(image).not.toHaveProperty(key);
    }
    const runtime = image.runtime as Record<string, unknown>;
    expect(Object.values(runtime)).not.toContain(null);
    expect(runtime.lifecycle).toEqual({ state: "configured", known: true });
    expect(image.identity).toEqual({ stableId: "6F1C2D3E-4A5B-4C6D-8E7F-000000000000" });
  });

  test("detail full keeps the per-image capability inventory and null fields", async () => {
    const payload = await listImages(iosSimulators(2), { platform: "ios", detail: "full" });
    const image = (payload.images as Record<string, unknown>[])[0]!;

    expect(payload.host).toBeUndefined();
    expect(payload.capabilityProfiles).toBeUndefined();
    expect(image.configuredRamMb).toBeNull();
    expect(image.display).toEqual({
      width: null,
      height: null,
      density: null,
      units: "physical-pixels",
    });
    const inventory = image.capabilityInventory as { capabilities: { id: string }[] };
    expect(inventory.capabilities.map((entry) => entry.id)).toContain(
      "ios.simulator.audioOutputCapture",
    );
    expect(listDeviceImagesOutputSchema.safeParse(payload).success).toBe(true);
  });

  test("a spilled full inventory keeps counts and configuredInventory consistent", async () => {
    const payload = await listImages(iosSimulators(40), { platform: "ios", detail: "full" });
    const writer = new RecordingArtifactWriter();
    const inline = finalized(payload, writer);

    expect(writer.writes).toHaveLength(1);
    expect(inline.count).toBe(40);
    expect(inline.truncated).toBe(true);
    expect(inline.imagesReturned).toBe((inline.images as unknown[]).length);
    expect(inline.configuredInventory).toEqual(payload.configuredInventory);
  });
});
