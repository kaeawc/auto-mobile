import { expect, test } from "bun:test";
import type {
  TestSession,
  TestSessionEvent,
} from "../../../../src/db/prototypeTestSessionRepository";
import { recordableStep } from "../../../../src/features/prototype/testSession/prototypeTestSessionEvent";
import {
  buildPrototypeTestSessionReport,
  renderPrototypeTestSessionMarkdown,
} from "../../../../src/features/prototype/testSession/prototypeTestSessionReport";
import { event } from "../../../helpers/prototypeTestEvent";
import type { PrototypeEvent } from "../../../../src/features/observe/android/ctrlProxyProtocol";
export const session: TestSession = {
  test_session_id: "test-1",
  prototype_id: "panel",
  device_id: "device",
  session_uuid: "one",
  cohort: "new",
  goal: "checkout/done",
  start_screen: "checkout/home",
  status: "ended",
  started_at_ms: 100,
  ended_at_ms: 700,
  ended_reason: "end",
  dropped_count: 0,
};
function recorded(
  seq: number,
  timestamp: number,
  screen: string,
  overrides: Partial<PrototypeEvent> = {},
): TestSessionEvent {
  const step = recordableStep(
    {
      ...event(seq),
      timestamp,
      stacks: { checkout: { path: ["home", screen], depth: 2 } },
      ...overrides,
    },
    new Set(),
  );
  if (!step) {
    throw new Error("Fixture must be recordable");
  }
  return { ...step, seq, test_session_id: "test-1" };
}
const details = recorded(1, 200, "details", {
  kind: "screen_changed",
  name: "checkout",
  payload: { screen: "details", depth: 2 },
});
const tap = recorded(2, 300, "details", {
  name: "prototype_dead_tap",
  payload: { stack: "checkout", screen: "details", x: 96.1, y: 47.9 },
});
const validation = recorded(3, 350, "details", { kind: "validation_failed", keys: ["email"] });
test("three-screen golden funnel, completion, visits, time, dead tap grid and counts", () => {
  const report = buildPrototypeTestSessionReport(
    session,
    [
      details,
      tap,
      validation,
      recorded(4, 400, "details", { kind: "page_changed", name: "pager", payload: 1 }),
      recorded(5, 500, "done", {
        kind: "screen_changed",
        name: "checkout",
        payload: { screen: "done", depth: 3 },
      }),
    ],
    999,
  );
  expect(report.funnel).toEqual([
    {
      screen: "checkout/home",
      reached: 1,
      left: 1,
      abandoned: 0,
      totalMs: 100,
      averageMs: 100,
      deadTaps: 0,
      validationFailures: 0,
    },
    {
      screen: "checkout/details",
      reached: 1,
      left: 1,
      abandoned: 0,
      totalMs: 300,
      averageMs: 300,
      deadTaps: 1,
      validationFailures: 1,
    },
    {
      screen: "checkout/done",
      reached: 1,
      left: 0,
      abandoned: 0,
      totalMs: 200,
      averageMs: 200,
      deadTaps: 0,
      validationFailures: 0,
    },
  ]);
  expect(report.completed).toBe(true);
  expect(report.lastScreenBeforeAbandonment).toBeNull();
  expect(report.deadTaps).toEqual([
    {
      screen: "checkout/details",
      count: 1,
      points: [{ x: 96.1, y: 47.9 }],
      grid: [{ col: 2, row: 0, count: 1 }],
    },
  ]);
  expect(report.validationFailures).toEqual([{ key: "email", count: 1 }]);
  expect(report.pageChanges).toEqual([{ pager: "pager", count: 1 }]);
  expect(report.timePerScreen.map((s) => s.screen)).toEqual([
    "checkout/details",
    "checkout/done",
    "checkout/home",
  ]);
  expect(renderPrototypeTestSessionMarkdown(report)).toContain(
    "| checkout/details | 1 | 1 | 0 | 300 | 300 | 1 | 1 |",
  );
  expect(renderPrototypeTestSessionMarkdown(report)).toContain(
    "No screenshot overlay is available yet.",
  );
});
test("a daemon release is not user abandonment", () => {
  const report = buildPrototypeTestSessionReport(
    { ...session, ended_reason: "released" },
    [details],
    0,
  );
  expect(report.lastScreenBeforeAbandonment).toBeNull();
  expect(report.funnel.every((screen) => screen.abandoned === 0)).toBe(true);
});
test("abandonment at details, goal unset, active sessions and backward timestamps", () => {
  const report = buildPrototypeTestSessionReport(
    session,
    [details, tap, { ...validation, at_ms: 150 }],
    0,
  );
  expect(report.completed).toBe(false);
  expect(report.lastScreenBeforeAbandonment).toBe("checkout/details");
  expect(report.funnel[1]?.abandoned).toBe(1);
  expect(report.funnel.reduce((sum, s) => sum + s.totalMs, 0)).toBe(600);
  expect(buildPrototypeTestSessionReport({ ...session, goal: null }, [], 0).completed).toBeNull();
  const active = buildPrototypeTestSessionReport(
    { ...session, status: "active", ended_at_ms: null },
    [],
    200,
  );
  expect(active.durationMs).toBe(100);
  expect(active.lastScreenBeforeAbandonment).toBeNull();
});
test("point cap, truncation, repeat visits and identical timestamps", () => {
  const taps = Array.from({ length: 205 }, (_, i) => ({ ...tap, seq: i + 2, at_ms: 300 }));
  const report = buildPrototypeTestSessionReport(
    { ...session, dropped_count: 4 },
    [details, ...taps, recorded(208, 400, "home"), recorded(209, 500, "details")],
    700,
  );
  expect(report.truncated).toBe(true);
  expect(report.deadTaps[0]?.points).toHaveLength(200);
  expect(report.deadTaps[0]?.grid).toEqual([{ col: 2, row: 0, count: 205 }]);
  expect(report.funnel[0]?.reached).toBe(2);
  expect(report.funnel[1]?.averageMs).toBe(200);
});
