import { describe, expect, test } from "bun:test";
import {
  VisualHighlight,
  VisualHighlightClient,
} from "../../../src/features/debug/VisualHighlight";
import type { HighlightDeviceClient } from "../../../src/features/debug/VisualHighlight";
import type { BootedDevice, HighlightOperationResult, HighlightShape } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";

describe("VisualHighlight", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    isEmulator: true,
    name: "Test Device",
  };
  const iosDevice: BootedDevice = {
    deviceId: "ios-device",
    platform: "ios",
    name: "iPhone Simulator",
  };

  const highlightShape: HighlightShape = {
    type: "box",
    bounds: {
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    },
    style: {
      strokeColor: "#FF0000",
      strokeWidth: 4,
    },
  };

  const pathShape: HighlightShape = {
    type: "path",
    points: [
      { x: 5, y: 10 },
      { x: 25, y: 40 },
      { x: 50, y: 20 },
    ],
    style: {
      strokeColor: "#FF8800",
      strokeWidth: 6,
      smoothing: "catmull-rom",
      tension: 0.6,
    },
  };

  test("addHighlight returns parsed highlight response", async () => {
    const response: HighlightOperationResult = {
      success: true,
    };

    const fakeClient = {
      requestAddHighlight: async () => response,
    };

    const highlight = new VisualHighlight(androidDevice, null, fakeClient as any);
    const result = await highlight.addHighlight("highlight-1", highlightShape);

    expect(result.success).toBe(true);
  });

  test("addHighlight accepts path shapes", async () => {
    const response: HighlightOperationResult = {
      success: true,
    };

    const fakeClient = {
      requestAddHighlight: async () => response,
    };

    const highlight = new VisualHighlight(androidDevice, null, fakeClient as any);
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
        type: "box" as const,
        bounds: { x: 10, y: 20, width: 0, height: 80 },
      },
    },
    {
      dimension: "height",
      invalidShape: {
        type: "box" as const,
        bounds: { x: 10, y: 20, width: 100, height: 0 },
      },
    },
  ])(
    "addHighlight names the invalid bounds $dimension before contacting the client",
    async ({ dimension, invalidShape }) => {
      let requests = 0;
      const fakeClient = {
        requestAddHighlight: async () => {
          requests += 1;
          return { success: true };
        },
      } as unknown as HighlightDeviceClient;

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
    const fakeClient = {
      requestAddHighlight: async () => ({
        invalid: true,
      }),
    };

    const highlight = new VisualHighlight(androidDevice, null, fakeClient as any);
    await expect(highlight.addHighlight("highlight-1", highlightShape)).rejects.toThrow(
      "Invalid highlight response",
    );
  });
});

describe("VisualHighlightClient", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    isEmulator: true,
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
    style: {
      strokeColor: "#00FF00",
      strokeWidth: 3,
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

    const client = new VisualHighlightClient(fakeSessionManager as any, () => fakeHighlight as any);

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

    const client = new VisualHighlightClient({} as any, (device) => {
      calls.push({ device, shape: highlightShape });
      return fakeHighlight as any;
    });

    const result = await client.addHighlight("highlight-1", highlightShape, {
      device: iosDevice,
      deviceId: iosDevice.deviceId,
      platform: "ios",
    });

    expect(result.success).toBe(true);
    expect(calls[0]?.device).toEqual(iosDevice);
  });
});
