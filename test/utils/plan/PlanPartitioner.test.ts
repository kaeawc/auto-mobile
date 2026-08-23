import { describe, expect, test } from "bun:test";
import { PlanPartitioner } from "../../../src/utils/plan/PlanPartitioner";
import type { Plan } from "../../../src/models/Plan";

describe("PlanPartitioner", () => {
  describe("partition", () => {
    test("returns null for plan without devices", () => {
      const plan: Plan = {
        name: "Test",
        steps: [{ tool: "tapOn", params: { text: "Login" } }],
      };
      expect(PlanPartitioner.partition(plan)).toBeNull();
    });

    test("returns null for plan with empty devices array", () => {
      const plan: Plan = {
        name: "Test",
        devices: [],
        steps: [],
      };
      expect(PlanPartitioner.partition(plan)).toBeNull();
    });

    test("partitions single-device plan", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone"],
        steps: [
          { tool: "tapOn", params: { text: "Login", device: "phone" } },
          { tool: "inputText", params: { text: "user", device: "phone" } },
        ],
      };

      const result = PlanPartitioner.partition(plan);
      expect(result).not.toBeNull();
      expect(result!.devices).toEqual(["phone"]);
      expect(result!.deviceTracks.get("phone")).toHaveLength(2);
      expect(result!.timeline).toHaveLength(2);
    });

    test("partitions multi-device plan into separate tracks", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone", "tablet"],
        steps: [
          { tool: "tapOn", params: { text: "Login", device: "phone" } },
          { tool: "tapOn", params: { text: "Login", device: "tablet" } },
          { tool: "inputText", params: { text: "user", device: "phone" } },
        ],
      };

      const result = PlanPartitioner.partition(plan)!;
      expect(result.devices).toEqual(["phone", "tablet"]);
      expect(result.deviceTracks.get("phone")).toHaveLength(2);
      expect(result.deviceTracks.get("tablet")).toHaveLength(1);
    });

    test("tracks planIndex correctly", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone", "tablet"],
        steps: [
          { tool: "tapOn", params: { text: "A", device: "phone" } },
          { tool: "tapOn", params: { text: "B", device: "tablet" } },
          { tool: "tapOn", params: { text: "C", device: "phone" } },
        ],
      };

      const result = PlanPartitioner.partition(plan)!;
      const phoneTracks = result.deviceTracks.get("phone")!;
      expect(phoneTracks[0].planIndex).toBe(0);
      expect(phoneTracks[0].trackIndex).toBe(0);
      expect(phoneTracks[1].planIndex).toBe(2);
      expect(phoneTracks[1].trackIndex).toBe(1);
    });

    test("criticalSection step lands only in its targeted device track", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone", "tablet"],
        steps: [
          { tool: "tapOn", params: { text: "A", device: "phone" } },
          {
            tool: "criticalSection",
            params: { device: "phone", lock: "sync", deviceCount: 2, steps: [] },
          },
          { tool: "tapOn", params: { text: "B", device: "tablet" } },
        ],
      };

      const result = PlanPartitioner.partition(plan)!;
      const phoneTrack = result.deviceTracks.get("phone")!;
      const tabletTrack = result.deviceTracks.get("tablet")!;

      expect(phoneTrack).toHaveLength(2); // tapOn + criticalSection
      expect(tabletTrack).toHaveLength(1); // tapOn only
      expect(phoneTrack[1].step.tool).toBe("criticalSection");

      // Every timeline entry is a device-tagged step (no broadcast barriers).
      expect(result.timeline).toHaveLength(3);
      expect(result.timeline.every((e) => e.type === "step")).toBe(true);
    });

    test("throws on missing device parameter", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone"],
        steps: [{ tool: "tapOn", params: { text: "A" } }],
      };

      expect(() => PlanPartitioner.partition(plan)).toThrow("missing device parameter");
    });

    test("throws on unknown device reference", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone"],
        steps: [{ tool: "tapOn", params: { text: "A", device: "tablet" } }],
      };

      expect(() => PlanPartitioner.partition(plan)).toThrow("unknown device");
    });

    test("timeline preserves step order", () => {
      const plan: Plan = {
        name: "Test",
        devices: ["phone", "tablet"],
        steps: [
          { tool: "tapOn", params: { text: "A", device: "phone" } },
          { tool: "tapOn", params: { text: "B", device: "tablet" } },
          {
            tool: "criticalSection",
            params: { device: "phone", lock: "sync", deviceCount: 2, steps: [] },
          },
          { tool: "tapOn", params: { text: "C", device: "phone" } },
        ],
      };

      const result = PlanPartitioner.partition(plan)!;
      expect(result.timeline).toHaveLength(4);
      expect(result.timeline.every((e) => e.type === "step")).toBe(true);
    });

    test("supports device definitions", () => {
      const plan: Plan = {
        name: "Test",
        devices: [
          { label: "phone", platform: "android" },
          { label: "tablet", platform: "ios" },
        ],
        steps: [
          { tool: "tapOn", params: { text: "A", device: "phone" } },
          { tool: "tapOn", params: { text: "B", device: "tablet" } },
        ],
      };

      const result = PlanPartitioner.partition(plan)!;
      expect(result.devices).toEqual(["phone", "tablet"]);
      expect(result.deviceTracks.get("phone")).toHaveLength(1);
      expect(result.deviceTracks.get("tablet")).toHaveLength(1);
    });
  });

  describe("getStepDevice", () => {
    const plan: Plan = {
      name: "Test",
      devices: ["phone", "tablet"],
      steps: [
        { tool: "tapOn", params: { text: "A", device: "phone" } },
        { tool: "criticalSection", params: { name: "sync" } },
        { tool: "tapOn", params: { text: "B", device: "tablet" } },
      ],
    };

    test("returns device for regular step", () => {
      expect(PlanPartitioner.getStepDevice(plan, 0)).toBe("phone");
      expect(PlanPartitioner.getStepDevice(plan, 2)).toBe("tablet");
    });

    test("returns undefined for criticalSection", () => {
      expect(PlanPartitioner.getStepDevice(plan, 1)).toBeUndefined();
    });

    test("returns undefined for out-of-bounds index", () => {
      expect(PlanPartitioner.getStepDevice(plan, -1)).toBeUndefined();
      expect(PlanPartitioner.getStepDevice(plan, 99)).toBeUndefined();
    });
  });

  describe("isMultiDevicePlan", () => {
    test("returns false for plan without devices", () => {
      const plan: Plan = { name: "Test", steps: [] };
      expect(PlanPartitioner.isMultiDevicePlan(plan)).toBe(false);
    });

    test("returns false for plan with empty devices", () => {
      const plan: Plan = { name: "Test", devices: [], steps: [] };
      expect(PlanPartitioner.isMultiDevicePlan(plan)).toBe(false);
    });

    test("returns true for plan with devices", () => {
      const plan: Plan = { name: "Test", devices: ["phone"], steps: [] };
      expect(PlanPartitioner.isMultiDevicePlan(plan)).toBe(true);
    });
  });
});
