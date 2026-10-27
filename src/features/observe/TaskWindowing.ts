import type { ElementBounds, TaskInfo } from "../../models";
import { LEGACY_TASK_HEADER, MODERN_TASK_HEADER } from "./taskHeaderPatterns";

/** A task's windowing state from `dumpsys activity activities` (#14115). */
export type TaskWindowing = Pick<TaskInfo, "windowingMode" | "bounds">;

/**
 * Pre-API-32 root-task header, printed before the root task's own `mBounds=` line:
 * `Stack #11: type=standard mode=fullscreen` (API 28-30) or
 * `RootTask #15: type=standard mode=fullscreen` (API 31). API 24-27 print no mode.
 */
const ROOT_TASK_HEADER = /^\s*(?:Stack|RootTask)\s+#\d+:(.*)$/;

/**
 * `mode=<windowingModeToString>` in a task or root-task header tail. Space-anchored so
 * `mWindowingMode=` and `mDisplayWindowingMode=` cannot match.
 */
const MODE_TOKEN = /(?:^|\s)mode=([^\s}]+)/;

/**
 * A task's or root task's requested override bounds: `mBounds=Rect(0, 640 - 320, 960)`.
 * `Rect(0, 0 - 0, 0)` means "inherit from the parent" and carries no bounds.
 */
const OVERRIDE_BOUNDS = /^\s*mBounds=Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)/;

/**
 * Resolved bounds (`WindowContainer.getBounds().toShortString()`), printed under each task
 * in the "Application tokens in top down Z order" section on API 30+:
 * `bounds=[0,640][320,960]`.
 */
const RESOLVED_BOUNDS = /^\s*bounds=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

/** An activity's resolved configuration: its winConfig opens with the activity bounds. */
const ACTIVITY_CONFIG_BOUNDS =
  /^\s*CurrentConfiguration=.*?winConfig=\{\s*mBounds=Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)/;
const ACTIVITY_CONFIG_MODE = /^\s*CurrentConfiguration=.*?\smWindowingMode=([^\s}]+)/;

/** A child record (`* Hist`, `* TaskFragment{`, `* ActivityRecord{`) ends a task's own fields. */
const CHILD_BULLET = /^\s*\*\s/;

interface Evidence {
  headerMode?: string;
  rootTaskMode?: string;
  activityMode?: string;
  resolved?: ElementBounds;
  override?: ElementBounds;
  rootTaskBounds?: ElementBounds;
  activityBounds?: ElementBounds;
}

interface RootTaskContext {
  mode?: string;
  bounds?: ElementBounds;
}

function rectFrom(match: RegExpMatchArray | null): ElementBounds | undefined {
  if (!match) {
    return undefined;
  }
  const [left, top, right, bottom] = match.slice(1, 5).map((value) => Number.parseInt(value, 10));
  // An empty rect is how the dump says "no override; inherit the parent's bounds".
  return right > left && bottom > top ? { left, top, right, bottom } : undefined;
}

function taskHeader(line: string): { id: number; tail: string } | undefined {
  const modern = line.match(MODERN_TASK_HEADER);
  if (modern) {
    return { id: Number.parseInt(modern[1], 10), tail: modern[2] };
  }
  const legacy = line.match(LEGACY_TASK_HEADER);
  if (legacy) {
    return { id: Number.parseInt(legacy[1] ?? legacy[2], 10), tail: legacy[3] ?? "" };
  }
  return undefined;
}

class WindowingScan {
  readonly evidence = new Map<number, Evidence>();
  private rootTask: RootTaskContext | undefined;
  private current: Evidence | undefined;
  /** True while the scan is on the task's own field lines, before its first child record. */
  private ownFields = false;

  line(line: string): void {
    if (/^\S/.test(line)) {
      // A top-level section ("Display #0 ...", "ActivityTaskSupervisor state:") ends every scope.
      this.rootTask = undefined;
      this.current = undefined;
      return;
    }
    const rootTaskHeader = line.match(ROOT_TASK_HEADER);
    if (rootTaskHeader) {
      this.rootTask = { mode: rootTaskHeader[1].match(MODE_TOKEN)?.[1] };
      this.current = undefined;
      return;
    }
    const header = taskHeader(line);
    if (header) {
      this.startTask(header.id, header.tail);
      return;
    }
    if (CHILD_BULLET.test(line)) {
      this.ownFields = false;
    }
    this.fields(line);
  }

  private startTask(id: number, tail: string): void {
    const evidence = this.evidence.get(id) ?? {};
    this.evidence.set(id, evidence);
    // First sighting wins: later sections repeat headers with their own, different blocks.
    evidence.headerMode ??= tail.match(MODE_TOKEN)?.[1];
    evidence.rootTaskMode ??= this.rootTask?.mode;
    evidence.rootTaskBounds ??= this.rootTask?.bounds;
    this.current = evidence;
    this.ownFields = true;
  }

  private fields(line: string): void {
    const override = line.match(OVERRIDE_BOUNDS);
    if (override) {
      this.overrideBounds(rectFrom(override));
      return;
    }
    if (this.current) {
      this.taskFields(this.current, line);
    }
  }

  /** A task's own `mBounds=` line, or a pre-API-32 root task's when no task is open yet. */
  private overrideBounds(bounds: ElementBounds | undefined): void {
    if (this.current && this.ownFields) {
      this.current.override ??= bounds;
    } else if (this.rootTask && !this.current) {
      this.rootTask.bounds = bounds;
    }
  }

  private taskFields(current: Evidence, line: string): void {
    const resolved = line.match(RESOLVED_BOUNDS);
    if (resolved && this.ownFields) {
      current.resolved ??= rectFrom(resolved);
      return;
    }
    const activityBounds = line.match(ACTIVITY_CONFIG_BOUNDS);
    if (activityBounds) {
      // The first activity printed under a task is its top activity.
      current.activityBounds ??= rectFrom(activityBounds);
      current.activityMode ??= line.match(ACTIVITY_CONFIG_MODE)?.[1];
    }
  }
}

/**
 * Parses each task's windowing mode and bounds out of `dumpsys activity activities`.
 *
 * Mode: the task header's `mode=` (API 30+), else the enclosing `Stack #N: ... mode=`
 * header (API 28-29), else the top activity's `mWindowingMode`.
 * Bounds: the resolved `bounds=[l,t][r,b]` (API 30+), else the task's own non-empty
 * `mBounds=Rect(...)`, else its root task's, else the top activity's configuration bounds.
 */
export function parseTaskWindowing(dumpsys: string): Map<number, TaskWindowing> {
  const scan = new WindowingScan();
  for (const line of dumpsys.split(/\r?\n/)) {
    scan.line(line);
  }
  const windowing = new Map<number, TaskWindowing>();
  for (const [id, evidence] of scan.evidence) {
    const windowingMode = evidence.headerMode ?? evidence.rootTaskMode ?? evidence.activityMode;
    const bounds =
      evidence.resolved ?? evidence.override ?? evidence.rootTaskBounds ?? evidence.activityBounds;
    windowing.set(id, {
      ...(windowingMode === undefined ? {} : { windowingMode }),
      ...(bounds === undefined ? {} : { bounds }),
    });
  }
  return windowing;
}

/** Copies parsed windowing state onto the back stack's tasks. */
export function applyTaskWindowing(
  tasks: TaskInfo[],
  windowing: ReadonlyMap<number, TaskWindowing>,
): void {
  for (const task of tasks) {
    const entry = windowing.get(task.id);
    if (entry?.windowingMode !== undefined) {
      task.windowingMode = entry.windowingMode;
    }
    if (entry?.bounds !== undefined) {
      task.bounds = entry.bounds;
    }
  }
}
