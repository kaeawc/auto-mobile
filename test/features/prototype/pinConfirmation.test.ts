import { describe, expect, test } from "bun:test";
import {
  confirmPinDialog,
  findPinConfirmButton,
  type PinConfirmationDriver,
} from "../../../src/features/prototype/pinConfirmation";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ViewHierarchyResult } from "../../../src/models";
import { pinDialogTree } from "../../helpers/pinDialogTree";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../../fakes/FakeTimer";

// No captured launcher pin-dialog hierarchy exists in the repo yet (#12261), so these trees only
// exercise the matcher and control flow; real launcher dialogs stay needs-device-verify.
const searchable = new SearchableHierarchy();
const nodesOf = (...labels: string[]) => searchable.project(pinDialogTree(labels));

describe("findPinConfirmButton", () => {
  test("taps the centre of Add to home screen", () => {
    expect(findPinConfirmButton(nodesOf("Cancel", "Add to home screen"))).toEqual({
      kind: "found",
      label: "Add to home screen",
      x: 250,
      y: 130,
    });
  });
  test("bare Add needs a Cancel beside it and never taps Cancel", () => {
    expect(findPinConfirmButton(nodesOf("Add"))).toEqual({ kind: "absent" });
    expect(findPinConfirmButton(nodesOf("Cancel", "Add"))).toMatchObject({
      kind: "found",
      x: 250,
    });
  });
  test("a dialog with only unknown buttons is unrecognized", () => {
    expect(findPinConfirmButton(nodesOf("Cancel", "Place"))).toEqual({
      kind: "unrecognized",
      visibleButtons: ["Cancel", "Place"],
    });
  });
  test("no dialog is absent", () => {
    expect(findPinConfirmButton(nodesOf("Settings"))).toEqual({ kind: "absent" });
  });
});

function driver(trees: ViewHierarchyResult[], failTap = false) {
  const timer = new FakeTimer();
  const taps: Array<[number, number]> = [];
  let reads = 0;
  const capture = new FakeHierarchyCapture(
    () => trees[Math.min(reads++, trees.length - 1)],
    "android",
    timer,
  );
  const value: PinConfirmationDriver = {
    capture,
    timer,
    tapAt: async (x, y) => {
      if (failTap) {
        throw new Error("no input");
      }
      taps.push([x, y]);
    },
  };
  return { value, taps, timer, reads: () => reads };
}

describe("confirmPinDialog", () => {
  test("waits for the dialog, then taps once", async () => {
    const d = driver([pinDialogTree([]), pinDialogTree(["Add to home screen"])]);
    d.timer.enableAutoAdvance();
    expect(await confirmPinDialog(d.value)).toEqual({
      status: "tapped",
      label: "Add to home screen",
    });
    expect(d.taps).toEqual([[50, 130]]);
  });
  test("times out on the injected timer when no dialog appears", async () => {
    const d = driver([pinDialogTree([])]);
    d.timer.enableAutoAdvance();
    expect(await confirmPinDialog(d.value, { timeoutMs: 1000, pollMs: 250 })).toEqual({
      status: "timeout",
    });
    expect(d.taps).toEqual([]);
  });
  test("an unknown dialog is reported, not tapped", async () => {
    const d = driver([pinDialogTree(["Cancel", "Place"])]);
    expect(await confirmPinDialog(d.value)).toEqual({
      status: "unrecognized",
      visibleButtons: ["Cancel", "Place"],
    });
    expect(d.taps).toEqual([]);
  });
  test("a failed tap is reported", async () => {
    const d = driver([pinDialogTree(["Add to home screen"])], true);
    expect(await confirmPinDialog(d.value)).toEqual({ status: "tap_failed", error: "no input" });
  });
});
