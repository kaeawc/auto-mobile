import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { createDefaultPlanExecutor } from "../../src/server/planExecutorFactory";
import { convertDebugStepsToRecords } from "../../src/server/planExecutionOrchestrator";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const PIN = "7391";

/**
 * Plan step details are returned by executePlan and persisted as test-execution step rows, so a
 * credential in a step's params must never reach them (#14107).
 */
describe("plan step details redact tool credentials", () => {
  let restoreRegistry: () => void;
  let succeed = true;

  beforeEach(() => {
    restoreRegistry = preserveToolRegistry();
    ToolRegistry.register("setDeviceState", "fake setter", z.object({}).passthrough(), async () =>
      createStructuredToolResponse(
        succeed ? { success: true } : { success: false, error: "locksettings refused" },
      ),
    );
  });

  afterEach(() => {
    restoreRegistry();
  });

  for (const outcome of ["completed", "failed", "skipped"] as const) {
    test(`a ${outcome} step keeps the lock type and drops the credential`, async () => {
      succeed = outcome === "completed";
      const result = await createDefaultPlanExecutor(new FakeTimer()).executePlan(
        {
          name: "lock",
          steps: [
            {
              tool: "setDeviceState",
              params: { screenLock: { type: "pin", credential: PIN } },
              optional: outcome === "skipped",
            },
          ],
        },
        0,
      );

      const steps = result.debug?.steps ?? [];
      expect(steps[0]?.status).toBe(outcome);
      expect(steps[0]?.details.params).toEqual({
        screenLock: { type: "pin", credential: "<redacted>" },
      });
      expect(JSON.stringify([steps, convertDebugStepsToRecords(steps)])).not.toContain(PIN);
    });
  }
});
