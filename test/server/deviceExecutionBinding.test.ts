import { describe, expect, test } from "bun:test";
import {
  ambientDeviceExecutionBinding,
  ambientExecutionIdReader,
} from "../../src/server/deviceExecutionBinding";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { FakeDeviceExecutionBinding } from "../fakes/FakeDeviceExecutionBinding";

describe("ambient device execution binding", () => {
  test("inherits the injected binding across internal tool contexts", async () => {
    const binding = new FakeDeviceExecutionBinding();
    await runWithToolSelectionContext(
      {
        execution: {
          executionId: "work",
          startTime: 0,
          deviceBinding: binding,
        },
      },
      async () => {
        await runWithToolSelectionContext({ routingSessionUuid: "nested" }, async () => {
          ambientDeviceExecutionBinding.bindDeviceExecution("emulator-5554");
          expect(ambientExecutionIdReader.getExecutionId()).toBe("work");
        });
      },
    );
    expect(binding.deviceIds).toEqual(["emulator-5554"]);
    // Untracked work has no execution to associate.
    ambientDeviceExecutionBinding.bindDeviceExecution("emulator-5556");
    expect(binding.deviceIds).toEqual(["emulator-5554"]);
    expect(ambientExecutionIdReader.getExecutionId()).toBeUndefined();
  });
});
