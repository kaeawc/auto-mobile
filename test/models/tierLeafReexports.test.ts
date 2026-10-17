import { describe, expect, test } from "bun:test";
import * as modelsDescribe from "../../src/models/describeUnknownError";
import * as utilsDescribe from "../../src/utils/describeUnknownError";
import { processTimingData } from "../../src/utils/PerformanceTracker";
import type { TimingData } from "../../src/models/TimingData";

// #11789: these symbols moved down into `models`; the utils paths must keep resolving to the same implementation.
describe("models-tier leaf re-exports", () => {
  test("utils describeUnknownError re-exports the models implementation", () => {
    expect(utilsDescribe.describeUnknownError).toBe(modelsDescribe.describeUnknownError);
    expect(utilsDescribe.errorMessage).toBe(modelsDescribe.errorMessage);
    expect(modelsDescribe.errorMessage(new Error("boom"))).toBe("boom");
  });

  test("TimingData from models is accepted by the PerformanceTracker consumers", () => {
    const timings: TimingData = [{ name: "a", durationMs: 5 }];
    expect(processTimingData(timings)).not.toBeNull();
  });
});
