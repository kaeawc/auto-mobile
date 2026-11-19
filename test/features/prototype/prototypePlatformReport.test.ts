import { expect, test } from "bun:test";
import reports from "../../fixtures/prototype-platform-report/report.json";
import { InMemoryPrototypeStatusStore } from "../../../src/features/prototype/PrototypeStatusStore";
import { prototypeRuntimeNotes } from "../../../src/features/prototype/prototypePlatformNotes";
import { prototypePlatformReportSchema } from "../../../src/features/prototype/prototypePlatformReport";
import { FakeTimer } from "../../fakes/FakeTimer";
import { event } from "../../helpers/prototypeTestEvent";

test("replays the shared runtime reports with all availability reasons", () => {
  expect<unknown>(prototypePlatformReportSchema.array().parse(reports)).toEqual(reports);
  expect(
    prototypePlatformReportSchema.safeParse({
      runtime: "embedded",
      modules: { cast: { availability: "degraded", reason: "unknown" } },
    }).success,
  ).toBe(false);
});

test("mirrors explicit call telemetry only within the reporting scope", () => {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  const scope = { deviceId: "device", sessionUuid: "session" };
  store.adopt(scope, {
    id: event(1).id,
    pages: {},
    state: {},
    platformRuntime: prototypePlatformReportSchema.parse(reports[0]),
  });
  const pushed = {
    ...event(1),
    kind: "emit" as const,
    name: "prototype_platform",
    payload: {
      callId: "call",
      call: "notifications.post",
      outcome: "success",
      durationMs: 0,
      mode: "fake",
      inFlight: 1,
    },
    timestamp: 10,
  };
  store.recordEvent(scope, pushed);
  store.recordEvent(scope, {
    ...pushed,
    timestamp: 9,
    payload: { ...pushed.payload, inFlight: 2 },
  });
  expect(store.status(scope).platformRuntime?.modules.notifications).toEqual({
    availability: "ready",
    mode: "fake",
    inFlight: 1,
  });
  expect(store.status({ deviceId: "device" }).platformRuntime).toBeUndefined();
});

test("shows one note per reported module reason", () => {
  const notes = reports.flatMap((report) =>
    prototypeRuntimeNotes(
      report.runtime === "iosAgent" ? "ios" : "android",
      prototypePlatformReportSchema.parse(report),
    ),
  );
  expect(notes.map(({ construct, effect }) => [construct, effect])).toEqual([
    ["platform.cast", "ignored"],
    ["platform.camera", "ignored"],
    ["platform.haptics", "simulated"],
    ["platform.biometric", "ignored"],
    ["platform.cast", "simulated"],
  ]);
});
