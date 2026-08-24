import { expect, describe, test } from "bun:test";
import { PlanPartitioner } from "../../src/utils/plan/PlanPartitioner";
import { Plan } from "../../src/models/Plan";

describe("PlanPartitioner", () => {
  describe("partition", () => {
    test("should return null for single-device plans without devices field", () => {
      const plan: Plan = {
        name: "Single Device Plan",
        steps: [
          { tool: "observe", params: {} },
          { tool: "tapOn", params: { text: "Login" } },
        ],
      };

      const result = PlanPartitioner.partition(plan);
      expect(result).toBeNull();
    });

    test("should partition multi-device plan into device tracks", () => {
      const plan: Plan = {
        name: "Multi-Device Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { text: "Login", device: "B" } },
          { tool: "observe", params: { device: "A" } },
          { tool: "swipeOn", params: { direction: "up", device: "B" } },
        ],
      };

      const result = PlanPartitioner.partition(plan);
      expect(result).not.toBeNull();
      expect(result!.devices).toEqual(["A", "B"]);

      // Check device A track
      const trackA = result!.deviceTracks.get("A")!;
      expect(trackA).toHaveLength(2);
      expect(trackA[0].step.tool).toBe("observe");
      expect(trackA[0].planIndex).toBe(0);
      expect(trackA[0].trackIndex).toBe(0);
      expect(trackA[1].step.tool).toBe("observe");
      expect(trackA[1].planIndex).toBe(2);
      expect(trackA[1].trackIndex).toBe(1);

      // Check device B track
      const trackB = result!.deviceTracks.get("B")!;
      expect(trackB).toHaveLength(2);
      expect(trackB[0].step.tool).toBe("tapOn");
      expect(trackB[0].planIndex).toBe(1);
      expect(trackB[0].trackIndex).toBe(0);
      expect(trackB[1].step.tool).toBe("swipeOn");
      expect(trackB[1].planIndex).toBe(3);
      expect(trackB[1].trackIndex).toBe(1);
    });

    test("should partition plan with device definitions", () => {
      const plan: Plan = {
        name: "Multi-Device Plan",
        devices: [
          { label: "A", platform: "ios" },
          { label: "B", platform: "ios" },
        ],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { text: "Login", device: "B" } },
        ],
      };

      const result = PlanPartitioner.partition(plan);
      expect(result).not.toBeNull();
      expect(result!.devices).toEqual(["A", "B"]);
    });

    test("should route a per-device critical section to its targeted track", () => {
      const plan: Plan = {
        name: "Plan with Critical Section",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "sync1",
              deviceCount: 2,
              steps: [{ tool: "tapOn", params: { text: "Sync", device: "A" } }],
            },
          },
          { tool: "observe", params: { device: "B" } },
        ],
      };

      const result = PlanPartitioner.partition(plan);
      expect(result).not.toBeNull();

      // Device A picks up the criticalSection because it targets device A
      const trackA = result!.deviceTracks.get("A")!;
      expect(trackA).toHaveLength(2); // observe + criticalSection
      expect(trackA[0].step.tool).toBe("observe");
      expect(trackA[1].step.tool).toBe("criticalSection");

      // Device B only sees its own observe step
      const trackB = result!.deviceTracks.get("B")!;
      expect(trackB).toHaveLength(1);
      expect(trackB[0].step.tool).toBe("observe");

      // Timeline has three entries, all device-tagged steps
      expect(result!.timeline).toHaveLength(3);
      expect(result!.timeline.every((e) => e.type === "step")).toBe(true);
    });

    test("should handle multiple critical sections that share a lock across devices", () => {
      const plan: Plan = {
        name: "Plan with Multiple Critical Sections",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          {
            tool: "criticalSection",
            params: { device: "A", lock: "sync1", deviceCount: 2, steps: [] },
          },
          {
            tool: "criticalSection",
            params: { device: "B", lock: "sync1", deviceCount: 2, steps: [] },
          },
          { tool: "tapOn", params: { device: "B" } },
          {
            tool: "criticalSection",
            params: { device: "A", lock: "sync2", deviceCount: 2, steps: [] },
          },
          {
            tool: "criticalSection",
            params: { device: "B", lock: "sync2", deviceCount: 2, steps: [] },
          },
          { tool: "observe", params: { device: "A" } },
        ],
      };

      const result = PlanPartitioner.partition(plan);
      expect(result).not.toBeNull();

      // Device A: observe, cs(sync1), cs(sync2), observe
      const trackA = result!.deviceTracks.get("A")!;
      expect(trackA).toHaveLength(4);
      expect(trackA.map((t) => t.step.tool)).toEqual([
        "observe",
        "criticalSection",
        "criticalSection",
        "observe",
      ]);

      // Device B: cs(sync1), tapOn, cs(sync2)
      const trackB = result!.deviceTracks.get("B")!;
      expect(trackB).toHaveLength(3);
      expect(trackB.map((t) => t.step.tool)).toEqual([
        "criticalSection",
        "tapOn",
        "criticalSection",
      ]);
    });

    test("should route criticalSection with params.device only to that device's track", () => {
      const plan: Plan = {
        name: "Per-Device Critical Sections",
        devices: ["A", "B"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              device: "A",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "inputText", params: { device: "A", text: "hi" } }],
            },
          },
          {
            tool: "criticalSection",
            params: {
              device: "B",
              lock: "shared",
              deviceCount: 2,
              steps: [{ tool: "observe", params: { device: "B" } }],
            },
          },
        ],
      };

      const result = PlanPartitioner.partition(plan)!;

      const trackA = result.deviceTracks.get("A")!;
      const trackB = result.deviceTracks.get("B")!;

      // Each device gets ONLY its own criticalSection step, not the other's
      expect(trackA).toHaveLength(1);
      expect(trackA[0].step.params!.device).toBe("A");
      expect(trackA[0].planIndex).toBe(0);

      expect(trackB).toHaveLength(1);
      expect(trackB[0].step.params!.device).toBe("B");
      expect(trackB[0].planIndex).toBe(1);

      // Per-device critical sections appear as device "step" entries in the timeline,
      // not as global barriers.
      expect(result.timeline).toHaveLength(2);
      expect(result.timeline[0].type).toBe("step");
      expect(result.timeline[1].type).toBe("step");
    });

    test("should throw when criticalSection params.device references unknown device", () => {
      const plan: Plan = {
        name: "Invalid Per-Device Critical Section",
        devices: ["A", "B"],
        steps: [
          {
            tool: "criticalSection",
            params: {
              device: "C",
              lock: "shared",
              deviceCount: 2,
              steps: [],
            },
          },
        ],
      };

      expect(() => PlanPartitioner.partition(plan)).toThrow("unknown device");
    });

    test("should handle device with no steps before its first critical section", () => {
      const plan: Plan = {
        name: "Plan with Empty Device Track",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { device: "A" } },
          {
            tool: "criticalSection",
            params: { device: "B", lock: "sync1", deviceCount: 1, steps: [] },
          },
          { tool: "observe", params: { device: "B" } },
        ],
      };

      const result = PlanPartitioner.partition(plan);
      expect(result).not.toBeNull();

      // Device A has 2 steps (observe + tapOn)
      const trackA = result!.deviceTracks.get("A")!;
      expect(trackA).toHaveLength(2);

      // Device B has 2 steps (criticalSection + observe), even though its
      // first activity is a criticalSection.
      const trackB = result!.deviceTracks.get("B")!;
      expect(trackB).toHaveLength(2);
      expect(trackB[0].step.tool).toBe("criticalSection");
      expect(trackB[1].step.tool).toBe("observe");
    });

    test("should throw error if step references unknown device", () => {
      const plan: Plan = {
        name: "Invalid Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { device: "C" } }, // Unknown device
        ],
      };

      expect(() => PlanPartitioner.partition(plan)).toThrow("references unknown device");
    });

    test("should maintain correct plan and track indices", () => {
      const plan: Plan = {
        name: "Index Tracking Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } }, // plan: 0, A track: 0
          { tool: "tapOn", params: { device: "B" } }, // plan: 1, B track: 0
          { tool: "observe", params: { device: "A" } }, // plan: 2, A track: 1
          { tool: "observe", params: { device: "B" } }, // plan: 3, B track: 1
          { tool: "tapOn", params: { device: "A" } }, // plan: 4, A track: 2
        ],
      };

      const result = PlanPartitioner.partition(plan);
      expect(result).not.toBeNull();

      const trackA = result!.deviceTracks.get("A")!;
      expect(trackA[0].planIndex).toBe(0);
      expect(trackA[0].trackIndex).toBe(0);
      expect(trackA[1].planIndex).toBe(2);
      expect(trackA[1].trackIndex).toBe(1);
      expect(trackA[2].planIndex).toBe(4);
      expect(trackA[2].trackIndex).toBe(2);

      const trackB = result!.deviceTracks.get("B")!;
      expect(trackB[0].planIndex).toBe(1);
      expect(trackB[0].trackIndex).toBe(0);
      expect(trackB[1].planIndex).toBe(3);
      expect(trackB[1].trackIndex).toBe(1);
    });
  });

  describe("getStepDevice", () => {
    test("should return device label for regular steps", () => {
      const plan: Plan = {
        name: "Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          { tool: "tapOn", params: { device: "B" } },
        ],
      };

      expect(PlanPartitioner.getStepDevice(plan, 0)).toBe("A");
      expect(PlanPartitioner.getStepDevice(plan, 1)).toBe("B");
    });

    test("should return undefined for critical sections", () => {
      const plan: Plan = {
        name: "Plan",
        devices: ["A", "B"],
        steps: [
          { tool: "observe", params: { device: "A" } },
          {
            tool: "criticalSection",
            params: { lock: "sync1", deviceCount: 2, steps: [] },
          },
        ],
      };

      expect(PlanPartitioner.getStepDevice(plan, 0)).toBe("A");
      expect(PlanPartitioner.getStepDevice(plan, 1)).toBeUndefined();
    });

    test("should return undefined for out of bounds indices", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [{ tool: "observe", params: {} }],
      };

      expect(PlanPartitioner.getStepDevice(plan, -1)).toBeUndefined();
      expect(PlanPartitioner.getStepDevice(plan, 10)).toBeUndefined();
    });
  });

  describe("isMultiDevicePlan", () => {
    test("should return true for plans with devices field", () => {
      const plan: Plan = {
        name: "Plan",
        devices: ["A"],
        steps: [{ tool: "observe", params: { device: "A" } }],
      };

      expect(PlanPartitioner.isMultiDevicePlan(plan)).toBe(true);
    });

    test("should return false for plans without devices field", () => {
      const plan: Plan = {
        name: "Plan",
        steps: [{ tool: "observe", params: {} }],
      };

      expect(PlanPartitioner.isMultiDevicePlan(plan)).toBe(false);
    });

    test("should return false for plans with empty devices array", () => {
      const plan: Plan = {
        name: "Plan",
        devices: [],
        steps: [{ tool: "observe", params: {} }],
      };

      expect(PlanPartitioner.isMultiDevicePlan(plan)).toBe(false);
    });
  });
});
