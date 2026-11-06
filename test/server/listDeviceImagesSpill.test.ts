import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
  finalizeToolResponse,
  type FinalizeToolResponseContext,
  type ObservationArtifactMetadata,
  type ObservationArtifactWriteInput,
  type ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";
import {
  createStructuredToolResponse,
  getStructuredPayload,
  stringifyToolResponse,
} from "../../src/utils/toolUtils";
import { listDeviceImagesOutputSchema } from "../../src/features/deviceLifecycle/core/toolSchemas";

class RecordingArtifactWriter implements ObservationArtifactWriter {
  writes: ObservationArtifactWriteInput[] = [];

  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    this.writes.push(input);
    return {
      artifact: {
        path: `/tmp/auto-mobile/${input.tool}-${this.writes.length}.json`,
        format: "json",
        payload: input.payload,
        bytes: 123,
        tool: input.tool,
        resourceUri: `automobile:tool-output/${input.tool}-${this.writes.length}`,
      },
    };
  }
}

/** ~2.5 KB per image, like the 34-image / 86 KB iOS inventory in #17235. */
function generatedImages(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "image",
    platform: "ios",
    name: `iPhone ${index}`,
    deviceId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    detail: "d".repeat(2_400),
  }));
}

const configuredInventory = {
  schemaVersion: 1,
  complete: true,
  observations: { ios: { complete: true } },
};

const capabilityProfiles = {
  p1: { schemaVersion: 1, capabilities: [{ id: "ios.simulator.biometric", state: "supported" }] },
};
const host = {
  capabilities: [{ id: "ios.simulator.audioInput", state: "supported", source: "host_audio" }],
};

function finalizeInventory(
  imageCount: number,
  writer: RecordingArtifactWriter,
  compact: Record<string, unknown> = {},
) {
  const images = generatedImages(imageCount);
  const ctx: FinalizeToolResponseContext = {
    name: "listDeviceImages",
    artifactWriter: writer,
    outputSchema: listDeviceImagesOutputSchema,
  };
  const response = finalizeToolResponse(
    createStructuredToolResponse({
      message: `Found ${images.length} configured ios device images`,
      images,
      count: images.length,
      platform: "ios",
      configuredInventory,
      ...compact,
    }),
    ctx,
  );
  const payload = getStructuredPayload<Record<string, unknown>>(response);
  if (!payload) {
    throw new Error("Expected structured listDeviceImages payload");
  }
  return payload;
}

describe("listDeviceImages oversized spill (#17235)", () => {
  test("keeps configuredInventory and marks the inline images as truncated", () => {
    const writer = new RecordingArtifactWriter();
    const payload = finalizeInventory(34, writer);

    expect(writer.writes).toHaveLength(1);
    expect(payload.artifact).toBeDefined();
    expect(payload.configuredInventory).toEqual(configuredInventory);
    expect(payload.count).toBe(34);
    expect(payload.platform).toBe("ios");
    const images = payload.images as unknown[];
    expect(images.length).toBeLessThan(34);
    expect(payload.truncated).toBe(true);
    expect(payload.imagesReturned).toBe(images.length);
    expect(Buffer.byteLength(stringifyToolResponse(payload), "utf8")).toBeLessThanOrEqual(
      DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
    );
  });

  test("keeps the host block, and no profile when no inline image refers to one", () => {
    const writer = new RecordingArtifactWriter();
    const payload = finalizeInventory(34, writer, { capabilityProfiles, host });

    expect(writer.writes).toHaveLength(1);
    expect(payload.truncated).toBe(true);
    expect(payload.capabilityProfiles).toEqual({});
    expect(payload.host).toEqual(host);
    expect(payload.configuredInventory).toEqual(configuredInventory);
  });

  test("keeps only profiles the inline images reference, and every reference resolves", () => {
    const writer = new RecordingArtifactWriter();
    // Five ~1.2 KB profiles: the whole map is over the 4 KB per-field cap.
    const manyProfiles = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `p${index + 1}`,
        {
          schemaVersion: 1,
          capabilities: [{ id: `cap.${index}`, state: "unsupported", reason: "r".repeat(1_200) }],
        },
      ]),
    );
    const images = Array.from({ length: 200 }, (_, index) => ({
      name: `iPhone ${index}`,
      identity: { stableId: `udid-${index}` },
      capabilityProfile: `p${(index % 5) + 1}`,
    }));
    const response = finalizeToolResponse(
      createStructuredToolResponse({
        message: "Found 200 configured ios device images",
        images,
        count: images.length,
        platform: "ios",
        configuredInventory,
        capabilityProfiles: manyProfiles,
        filler: "f".repeat(70_000),
      }),
      {
        name: "listDeviceImages",
        artifactWriter: writer,
        outputSchema: listDeviceImagesOutputSchema,
      },
    );
    const payload = getStructuredPayload<Record<string, unknown>>(response)!;
    const inline = payload.images as { capabilityProfile: string }[];
    const profiles = payload.capabilityProfiles as Record<string, unknown>;

    expect(writer.writes).toHaveLength(1);
    expect(profiles).not.toHaveProperty("_truncated");
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.every((image) => profiles[image.capabilityProfile] !== undefined)).toBe(true);
    expect(payload.imagesReturned).toBe(inline.length);
    expect(payload.truncated).toBe(true);
  });

  test("an unspilled inventory is complete inline and carries no truncation marker", () => {
    const writer = new RecordingArtifactWriter();
    const payload = finalizeInventory(3, writer);

    expect(writer.writes).toHaveLength(0);
    expect(payload.truncated).toBeUndefined();
    expect(payload.count).toBe((payload.images as unknown[]).length);
    expect(payload.configuredInventory).toEqual(configuredInventory);
  });

  test("the spilled shape is declared by the tool's output schema", () => {
    const shape = listDeviceImagesOutputSchema.shape;
    expect(shape.truncated.isOptional()).toBe(true);
    expect(shape.imagesReturned.isOptional()).toBe(true);
  });
});
