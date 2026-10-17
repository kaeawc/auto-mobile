import { describe, expect, test } from "bun:test";
import { isCoordinationTool } from "../../../src/utils/plan/coordinationTools";
import { isCoordinationTool as reexported } from "../../../src/utils/plan/BarrierResumeGuard";

describe("isCoordinationTool", () => {
  test("is true only for the rendezvous tools", () => {
    expect(isCoordinationTool("barrier")).toBe(true);
    expect(isCoordinationTool("criticalSection")).toBe(true);
    expect(isCoordinationTool("tapOn")).toBe(false);
  });

  test("BarrierResumeGuard re-exports the same predicate", () => {
    expect(reexported).toBe(isCoordinationTool);
  });
});
