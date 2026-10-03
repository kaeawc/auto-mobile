import { afterEach, expect, test } from "bun:test";
import {
  daemonDeviceAdmissionGate,
  setDeviceAdmissionGate,
} from "../../src/utils/deviceAdmissionGate";
import { ambientDeviceExecutionBinding } from "../../src/utils/deviceExecutionBinding";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { FakeDeviceExecutionBinding } from "../fakes/FakeDeviceExecutionBinding";

afterEach(() => setDeviceAdmissionGate(undefined));

test("the retained admission adapter follows pool installation, replacement and reset", () => {
  const calls: string[] = [];
  const gate = daemonDeviceAdmissionGate;
  gate.assertDeviceActionable("serial", "direct");
  setDeviceAdmissionGate({
    assertDeviceActionable: (id, purpose) => {
      calls.push(`${id}:${purpose}`);
    },
  });
  gate.assertDeviceActionable("serial", "first");
  setDeviceAdmissionGate({
    assertDeviceActionable: () => {
      throw new Error("quarantined");
    },
  });
  expect(() => gate.assertDeviceActionable("serial", "second")).toThrow("quarantined");
  setDeviceAdmissionGate(undefined);
  gate.assertDeviceActionable("serial", "reset");
  expect(calls).toEqual(["serial:first"]);
});

test("ambient binding follows inherited, replaced and explicitly unbound execution contexts", async () => {
  const parent = new FakeDeviceExecutionBinding();
  const child = new FakeDeviceExecutionBinding();
  await runWithToolSelectionContext(
    { execution: { executionId: "parent", startTime: 0, deviceBinding: parent } },
    async () => {
      await runWithToolSelectionContext({}, async () => {
        ambientDeviceExecutionBinding.bindDeviceExecution("inherited");
      });
      await runWithToolSelectionContext(
        { execution: { executionId: "child", startTime: 0, deviceBinding: child } },
        async () => {
          ambientDeviceExecutionBinding.bindDeviceExecution("child");
        },
      );
      await runWithToolSelectionContext(
        { execution: { executionId: "unbound", startTime: 0 } },
        async () => {
          ambientDeviceExecutionBinding.bindDeviceExecution("unbound");
        },
      );
      ambientDeviceExecutionBinding.bindDeviceExecution("restored");
    },
  );
  ambientDeviceExecutionBinding.bindDeviceExecution("outside");
  expect(parent.deviceIds).toEqual(["inherited", "restored"]);
  expect(child.deviceIds).toEqual(["child"]);
});
