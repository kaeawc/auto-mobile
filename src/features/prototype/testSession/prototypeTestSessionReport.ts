import type { TestSession, TestSessionEvent } from "../../../db/prototypeTestSessionRepository";
import { stepDetailSchema, type StepDetail } from "./prototypeTestSessionEvent";

export interface ScreenFunnel {
  screen: string;
  reached: number;
  left: number;
  abandoned: number;
  totalMs: number;
  averageMs: number;
  deadTaps: number;
  validationFailures: number;
}
interface DeadTaps {
  screen: string;
  count: number;
  points: { x: number; y: number }[];
  grid: { col: number; row: number; count: number }[];
}
export const TEST_SESSION_PRIVACY_NOTE =
  "No text values are recorded. Secure fields are excluded; other fields retain only keys, lengths/types and validity.";
export interface PrototypeTestSessionReport {
  id: string;
  prototypeId: string;
  deviceId: string;
  sessionUuid: string | null;
  cohort: string | null;
  goal: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  status: TestSession["status"];
  endedReason: TestSession["ended_reason"];
  eventCount: number;
  droppedCount: number;
  truncated: boolean;
  privacy: string;
  funnel: ScreenFunnel[];
  completed: boolean | null;
  lastScreenBeforeAbandonment: string | null;
  timePerScreen: { screen: string; totalMs: number; averageMs: number }[];
  deadTaps: DeadTaps[];
  validationFailures: { key: string; count: number }[];
  pageChanges: { pager: string; count: number }[];
}
function readDetail(event: TestSessionEvent): StepDetail {
  // detail_json is owned by the sanitizer and database, never a wire payload.
  return stepDetailSchema.parse(JSON.parse(event.detail_json));
}
function addDeadTap(taps: Map<string, DeadTaps>, screen: string, detail: StepDetail): void {
  if (detail.x === undefined || detail.y === undefined) {
    return;
  }
  const tap = taps.get(screen) ?? { screen, count: 0, points: [], grid: [] };
  taps.set(screen, tap);
  tap.count++;
  if (tap.points.length < 200) {
    tap.points.push({ x: detail.x, y: detail.y });
  }
  const col = Math.floor(detail.x / 48),
    row = Math.floor(detail.y / 48);
  const bin = tap.grid.find((cell) => cell.col === col && cell.row === row);
  if (bin) {
    bin.count++;
  } else {
    tap.grid.push({ col, row, count: 1 });
  }
}
function countDetails(event: TestSessionEvent, screen: ScreenFunnel, state: ReportCounts): void {
  const detail = readDetail(event);
  if (event.kind === "emit" && event.name === "prototype_dead_tap") {
    screen.deadTaps++;
    addDeadTap(state.taps, screen.screen, detail);
  }
  if (event.kind === "validation_failed") {
    screen.validationFailures++;
    for (const key of detail.keys ?? []) {
      state.fields.set(key, (state.fields.get(key) ?? 0) + 1);
    }
  }
  if (event.kind === "page_changed" && event.name !== null) {
    state.pagers.set(event.name, (state.pagers.get(event.name) ?? 0) + 1);
  }
}
interface ReportCounts {
  taps: Map<string, DeadTaps>;
  fields: Map<string, number>;
  pagers: Map<string, number>;
}
function visit(screens: Map<string, ScreenFunnel>, label: string): ScreenFunnel {
  const screen = screens.get(label) ?? {
    screen: label,
    reached: 0,
    left: 0,
    abandoned: 0,
    totalMs: 0,
    averageMs: 0,
    deadTaps: 0,
    validationFailures: 0,
  };
  screens.set(label, screen);
  screen.reached++;
  return screen;
}
export function buildPrototypeTestSessionReport(
  session: TestSession,
  events: readonly TestSessionEvent[],
  nowMs: number,
): PrototypeTestSessionReport {
  const screens = new Map<string, ScreenFunnel>();
  const counts: ReportCounts = { taps: new Map(), fields: new Map(), pagers: new Map() };
  let current = visit(screens, session.start_screen);
  let cursor = session.started_at_ms;
  let completed = session.goal === null ? null : session.goal === current.screen;
  const end = Math.max(session.started_at_ms, session.ended_at_ms ?? nowMs);
  for (const event of events) {
    const at = Math.min(end, Math.max(cursor, event.at_ms));
    current.totalMs += at - cursor;
    cursor = at;
    if (event.screen !== current.screen) {
      current.left++;
      current = visit(screens, event.screen);
    }
    if (session.goal === current.screen) {
      completed = true;
    }
    countDetails(event, current, counts);
  }
  current.totalMs += end - cursor;
  const abandoned =
    session.status === "ended" && session.ended_reason !== "released" && completed !== true;
  if (abandoned) {
    current.abandoned = 1;
  }
  const funnel = [...screens.values()].map((screen) => ({
    ...screen,
    averageMs: screen.totalMs / screen.reached,
  }));
  return {
    id: session.test_session_id,
    prototypeId: session.prototype_id,
    deviceId: session.device_id,
    sessionUuid: session.session_uuid,
    cohort: session.cohort,
    goal: session.goal,
    startedAt: session.started_at_ms,
    endedAt: session.ended_at_ms,
    durationMs: end - session.started_at_ms,
    status: session.status,
    endedReason: session.ended_reason,
    eventCount: events.length,
    droppedCount: session.dropped_count,
    truncated: session.dropped_count > 0,
    privacy: TEST_SESSION_PRIVACY_NOTE,
    funnel,
    completed,
    lastScreenBeforeAbandonment: abandoned ? current.screen : null,
    timePerScreen: funnel
      .map(({ screen, totalMs, averageMs }) => ({ screen, totalMs, averageMs }))
      .sort((a, b) => b.totalMs - a.totalMs),
    deadTaps: [...counts.taps.values()],
    validationFailures: [...counts.fields].map(([key, count]) => ({ key, count })),
    pageChanges: [...counts.pagers].map(([pager, count]) => ({ pager, count })),
  };
}
const cell = (value: string) =>
  value.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
export function renderPrototypeTestSessionMarkdown(report: PrototypeTestSessionReport): string {
  return [
    `# Prototype test session ${cell(report.id)}`,
    `Prototype: ${cell(report.prototypeId)} · Device: ${cell(report.deviceId)} · Status: ${report.status}`,
    `Cohort: ${cell(report.cohort ?? "—")} · Goal: ${cell(report.goal ?? "—")}`,
    `Completed: ${report.completed === null ? "no goal set" : report.completed} · Duration: ${report.durationMs} ms`,
    `Last screen before abandonment: ${cell(report.lastScreenBeforeAbandonment ?? "—")}`,
    `Events: ${report.eventCount} · Dropped: ${report.droppedCount} · Truncated: ${report.truncated}`,
    "",
    report.privacy,
    "",
    "| Screen | Reached | Left | Abandoned | Total ms | Average ms | Dead taps | Validation failures |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.funnel.map(
      (s) =>
        `| ${cell(s.screen)} | ${s.reached} | ${s.left} | ${s.abandoned} | ${s.totalMs} | ${s.averageMs} | ${s.deadTaps} | ${s.validationFailures} |`,
    ),
    "",
    "Dead taps use window-local dp (points on iOS), with a 48-unit grid. No screenshot overlay is available yet.",
    ...report.validationFailures.map(
      ({ key, count }) => `Validation failures: ${cell(key)} = ${count}`,
    ),
    ...report.pageChanges.map(({ pager, count }) => `Page changes: ${cell(pager)} = ${count}`),
  ].join("\n");
}
