import { describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice, type HighlightShape } from "../../src/models";
import type { VisualHighlightClient } from "../../src/features/debug/VisualHighlightClient";

export interface HighlightClientHandle {
  client: Pick<VisualHighlightClient, "addHighlight">;
  /** Make the next accepted highlight fail on the device side with `message`. */
  failNext(message: string): void;
}

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

const circle = (width = 40): HighlightShape => ({
  type: "circle",
  bounds: { x: 5, y: 10, width, height: 40 },
});

/**
 * Shared behavioural contract for the highlight client (#11868): the scripted FakeHighlightClient
 * and the real VisualHighlightClient (over a scripted device-side client) agree on which requests
 * resolve and which reject, so tests built on the fake see the failures production produces.
 */
export function runHighlightClientContract(name: string, make: () => HighlightClientHandle): void {
  describe(`HighlightClient contract: ${name}`, function () {
    test("resolves success for a valid circle on a matching device", async function () {
      const { client } = make();

      const result = await client.addHighlight("h-1", circle(), {
        device: androidDevice,
        platform: "android",
      });

      expect(result.success).toBe(true);
    });

    test("rejects when the requested platform differs from the device platform", async function () {
      const { client } = make();

      const rejected = client.addHighlight("h-1", circle(), {
        device: androidDevice,
        platform: "ios",
      });

      await expect(rejected).rejects.toBeInstanceOf(ActionableError);
      await expect(rejected).rejects.toThrow("platform mismatch");
    });

    test("rejects a shape whose bounds are not positive", async function () {
      const { client } = make();

      await expect(
        client.addHighlight("h-1", circle(0), { device: androidDevice, platform: "android" }),
      ).rejects.toBeInstanceOf(ActionableError);
    });

    test("rejects an empty highlight id", async function () {
      const { client } = make();

      await expect(
        client.addHighlight("", circle(), { device: androidDevice, platform: "android" }),
      ).rejects.toThrow("non-empty");
    });

    test("rejects with the device's error when the device reports failure", async function () {
      const { client, failNext } = make();
      failNext("Overlay service unavailable");

      await expect(
        client.addHighlight("h-1", circle(), { device: androidDevice, platform: "android" }),
      ).rejects.toThrow("Overlay service unavailable");
    });
  });
}
