import { describe, expect, test } from "bun:test";
import {
  deviceHighlightShapeSchema,
  highlightShapeSchema,
  VisualHighlight,
} from "../../../src/features/debug/VisualHighlight";
import { VisualHighlightClient } from "../../../src/features/debug/VisualHighlightClient";
import type { HighlightDeviceClient } from "../../../src/features/debug/VisualHighlight";
import type { BootedDevice, HighlightOperationResult, HighlightShape } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";

describe("VisualHighlight", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };
  const iosDevice: BootedDevice = {
    deviceId: "ios-device",
    platform: "ios",
    name: "iPhone Simulator",
  };

  const highlightShape: HighlightShape = {
    type: "circle",
    bounds: {
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    },
  };

  const pathShape: HighlightShape = {
    type: "circle",

    bounds: { x: 5, y: 10, width: 45, height: 30 },
  };

  test("forwards a daemon-resolved sourceScale to the device client (#17354)", async () => {
    const sent: HighlightShape[] = [];
    const fakeClient: HighlightDeviceClient = {
      requestAddHighlight: async (_id, shape) => {
        sent.push(shape);
        return { success: true };
      },
    };
    const shape: HighlightShape = {
      type: "circle",
      bounds: { ...highlightShape.bounds, sourceWidth: 390, sourceHeight: 844, sourceScale: 1 },
    };

    await new VisualHighlight(iosDevice, null, fakeClient).addHighlight("scaled", shape);

    expect(sent).toEqual([shape]);
  });

  test("sourceScale is daemon-only and needs a source size", () => {
    const scaled = {
      type: "circle",
      bounds: { ...highlightShape.bounds, sourceWidth: 600, sourceHeight: 900, sourceScale: 3 },
    };
    expect(deviceHighlightShapeSchema.safeParse(scaled).success).toBe(true);
    // The tool's caller-facing schema is unchanged: callers cannot send a scale.
    expect(highlightShapeSchema.safeParse(scaled).success).toBe(false);
    const withoutSource = deviceHighlightShapeSchema.safeParse({
      type: "circle",
      bounds: { ...highlightShape.bounds, sourceScale: 3 },
    });
    expect(withoutSource.success).toBe(false);
    for (const sourceScale of [0, -1, Number.POSITIVE_INFINITY]) {
      expect(
        deviceHighlightShapeSchema.safeParse({
          type: "circle",
          bounds: { ...highlightShape.bounds, sourceWidth: 600, sourceHeight: 900, sourceScale },
        }).success,
      ).toBe(false);
    }
  });

  test("addHighlight returns parsed highlight response", async () => {
    const response: HighlightOperationResult = {
      success: true,
    };

    const fakeClient: HighlightDeviceClient = {
      requestAddHighlight: async () => response,
    };

    const highlight = new VisualHighlight(androidDevice, null, fakeClient);
    const result = await highlight.addHighlight("highlight-1", highlightShape);

    expect(result.success).toBe(true);
  });

  test("addHighlight accepts circle bounds", async () => {
    const response: HighlightOperationResult = {
      success: true,
    };

    const fakeClient: HighlightDeviceClient = {
      requestAddHighlight: async () => response,
    };

    const highlight = new VisualHighlight(androidDevice, null, fakeClient);
    const result = await highlight.addHighlight("path-1", pathShape);

    expect(result.success).toBe(true);
  });

  test("addHighlight sends iOS highlight requests through the injected client", async () => {
    const calls: Array<{ id: string; shape: HighlightShape; timeoutMs: number | undefined }> = [];
    const fakeClient = {
      requestAddHighlight: async (id: string, shape: HighlightShape, timeoutMs?: number) => {
        calls.push({ id, shape, timeoutMs });
        return { success: true };
      },
    };

    const highlight = new VisualHighlight(iosDevice, null, fakeClient);
    const result = await highlight.addHighlight("ios-highlight-1", highlightShape, {
      timeoutMs: 1234,
    });

    expect(result.success).toBe(true);
    expect(calls).toEqual([{ id: "ios-highlight-1", shape: highlightShape, timeoutMs: 1234 }]);
  });

  test.each([
    {
      dimension: "width",
      invalidShape: {
        type: "circle" as const,
        bounds: { x: 10, y: 20, width: 0, height: 80 },
      },
    },
    {
      dimension: "height",
      invalidShape: {
        type: "circle" as const,
        bounds: { x: 10, y: 20, width: 100, height: 0 },
      },
    },
  ])(
    "addHighlight names the invalid bounds $dimension before contacting the client",
    async ({ dimension, invalidShape }) => {
      let requests = 0;
      const fakeClient: HighlightDeviceClient = {
        requestAddHighlight: async () => {
          requests += 1;
          return { success: true };
        },
      };

      const highlight = new VisualHighlight(androidDevice, null, fakeClient);
      const error = await highlight
        .addHighlight("highlight-1", invalidShape)
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(ActionableError);
      expect((error as Error).message).toContain(`bounds.${dimension}`);
      expect(requests).toBe(0);
    },
  );

  test("addHighlight rejects invalid highlight responses", async () => {
    const fakeClient: HighlightDeviceClient = {
      // The malformed payload a misbehaving client could return.
      requestAddHighlight: async () => ({ invalid: true }),
    };

    const highlight = new VisualHighlight(androidDevice, null, fakeClient);
    await expect(highlight.addHighlight("highlight-1", highlightShape)).rejects.toThrow(
      "Invalid highlight response",
    );
  });
});

describe("VisualHighlightClient", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };
  const iosDevice: BootedDevice = {
    deviceId: "ios-device",
    platform: "ios",
    name: "iPhone Simulator",
  };

  const highlightShape: HighlightShape = {
    type: "circle",
    bounds: {
      x: 5,
      y: 10,
      width: 40,
      height: 40,
    },
  };

  test("addHighlight throws when underlying operation fails", async () => {
    const fakeSessionManager = {
      ensureDeviceReady: async () => androidDevice,
    };

    const fakeHighlight = {
      addHighlight: async () => ({
        success: false,
        error: "Service error",
      }),
    };

    const client = new VisualHighlightClient(fakeSessionManager, () => fakeHighlight);

    await expect(
      client.addHighlight("highlight-1", highlightShape, {
        deviceId: androidDevice.deviceId,
        platform: "android",
      }),
    ).rejects.toThrow("Service error");
  });

  test("addHighlight accepts an iOS device option", async () => {
    const calls: Array<{ device: BootedDevice; shape: HighlightShape }> = [];
    const fakeHighlight = {
      addHighlight: async (_id: string, shape: HighlightShape) => {
        calls.push({ device: iosDevice, shape });
        return { success: true };
      },
    };

    const client = new VisualHighlightClient(
      { ensureDeviceReady: async () => iosDevice },
      (device) => {
        calls.push({ device, shape: highlightShape });
        return fakeHighlight;
      },
    );

    const result = await client.addHighlight("highlight-1", highlightShape, {
      device: iosDevice,
      deviceId: iosDevice.deviceId,
      platform: "ios",
    });

    expect(result.success).toBe(true);
    expect(calls[0]?.device).toEqual(iosDevice);
  });
});
