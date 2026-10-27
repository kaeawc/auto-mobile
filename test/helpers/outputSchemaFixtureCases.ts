import androidCapture from "../fixtures/observe/android-home.json";
import iosCapture from "../fixtures/observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json";
import actionCaptures from "../fixtures/android-action-compact/tapon-consecutive-emulator-5600.json";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

export const OUTPUT_SCHEMA_FIXTURES = [
  {
    label: "Android observe",
    name: "observe",
    observation: { ...androidCapture, observationId: "capture", deviceId: "android" },
  },
  { label: "iOS observe", name: "observe", observation: iosCapture },
  ...["tapOn", "launchApp", "pressButton", "terminateApp"].flatMap((name) => [
    {
      label: `Android ${name}`,
      name,
      observation: { ...androidCapture, observationId: "capture", deviceId: "android" },
    },
    { label: `iOS ${name}`, name, observation: iosCapture },
    {
      label: `${name} diff`,
      name,
      observation: {
        observationId: "diff-capture",
        deviceId: "android",
        display: androidCapture.display,
        isDiff: true,
        skeleton: [],
        added: [],
        removed: [],
        changed: [],
      },
    },
  ]),
];

export function finalizedSchemaFixture(
  fixture: (typeof OUTPUT_SCHEMA_FIXTURES)[number],
  project: "full" | "skeleton",
): Record<string, unknown> {
  const payload =
    fixture.name === "observe"
      ? fixture.observation
      : {
          ...actionCaptures.first,
          message: "Result",
          success: true,
          observation: fixture.observation,
        };
  const response = finalizeToolResponse(createStructuredToolResponse(payload), {
    name: fixture.name,
    args: { project },
  });
  if (!response.structuredContent) {
    throw new Error("Fixture lost structuredContent");
  }
  return response.structuredContent;
}

/** Mutations exercise the same nested observation typing on both advertisements. */
export function invalidSchemaFixtures(
  name: string,
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  const { observationId: _observationId, ...withoutObservationId } = payload;
  void _observationId;
  if (name === "observe") {
    return [
      { ...payload, observationId: 42 },
      { ...payload, screenSize: { width: "invalid", height: 100 } },
      withoutObservationId,
    ];
  }
  const mutants: Record<string, unknown>[] = [
    { ...payload, observation: "invalid" },
    { ...payload, observation: { observationId: 42 } },
    { ...payload, observation: { screenSize: { width: "invalid", height: 100 } } },
  ];
  const observation = payload.observation;
  if (
    observation &&
    typeof observation === "object" &&
    "isDiff" in observation &&
    observation.isDiff === true
  ) {
    mutants.push({ ...payload, observation: { ...observation, added: "invalid" } });
    const { skeleton: _skeleton, ...withoutSkeleton } = observation as Record<string, unknown>;
    void _skeleton;
    mutants.push({ ...payload, observation: withoutSkeleton });
  }
  return mutants;
}
