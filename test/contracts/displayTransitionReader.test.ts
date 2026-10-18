import { DisplayTransitionTracker } from "../../src/features/observe/DisplayTransition";
import { FakeDisplayTransitionReader } from "../fakes/FakeDisplayTransitionReader";
import { runDisplayTransitionReaderContract } from "./DisplayTransitionReaderContract";

const OBSERVATION_ID = "observation-1";

runDisplayTransitionReaderContract("DisplayTransitionTracker", () => {
  const tracker = new DisplayTransitionTracker(() => {});
  const observe = (
    deviceId: string,
    panel: { key: string; role: "inner" | "cover" },
    size = { width: 1080, height: 2400 },
  ) =>
    tracker.record(
      deviceId,
      {
        display: { ...panel, posture: "opened", generation: tracker.identityRevision(deviceId) },
        screenSize: size,
        observationId: OBSERVATION_ID,
      },
      "ios",
    );
  return {
    reader: tracker,
    transition: (deviceId) => tracker.notifyTransition(deviceId, "contract transition"),
    observe: (deviceId, panel) => {
      observe(deviceId, panel);
    },
    resize: (deviceId) => {
      observe(deviceId, { key: "inner", role: "inner" }, { width: 1200, height: 2600 });
    },
  };
});

runDisplayTransitionReaderContract("FakeDisplayTransitionReader", () => {
  const fake = new FakeDisplayTransitionReader();
  return {
    reader: fake,
    transition: (deviceId) => fake.transition(1, false, deviceId),
    observe: (deviceId, panel) => fake.observe(panel, deviceId),
    resize: (deviceId) => fake.resize(deviceId),
  };
});
