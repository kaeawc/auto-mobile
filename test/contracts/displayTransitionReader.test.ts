import { DisplayTransitionTracker } from "../../src/features/observe/DisplayTransition";
import type { DisplayRef } from "../../src/models";
import { FakeDisplayTransitionReader } from "../fakes/FakeDisplayTransitionReader";
import { runDisplayTransitionReaderContract } from "./DisplayTransitionReaderContract";

runDisplayTransitionReaderContract("FakeDisplayTransitionReader", () => {
  const reader = new FakeDisplayTransitionReader();
  return {
    reader,
    identityTransition: () => reader.transition(),
    geometryTransition: () => reader.geometryTransition(),
  };
});

const display: DisplayRef = { key: "inner", role: "inner", posture: "closed", generation: 0 };

runDisplayTransitionReaderContract("DisplayTransitionTracker (inert invalidators)", () => {
  const tracker = new DisplayTransitionTracker(
    () => {},
    () => {},
  );
  const device = "contract-device";
  // Identified iOS panel observed once: a later size change inside that same observation
  // is a geometry correction, which must not move the identity fence.
  tracker.record(
    device,
    { display, screenSize: { width: 100, height: 200 }, observationId: "obs" },
    "ios",
  );
  let width = 100;
  return {
    reader: tracker,
    identityTransition: () => tracker.notifyTransition(device, "contract identity change"),
    geometryTransition: () => {
      width += 1;
      tracker.checkIosGeometry(device, { width, height: 200 }, "obs", display);
    },
  };
});
