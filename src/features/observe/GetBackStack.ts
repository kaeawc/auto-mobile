import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BackStackInfo, ActivityInfo, TaskInfo, BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import type { BackStack } from "./interfaces/BackStack";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

/**
 * Legacy task header, printed by the pre-Android-10 `dumpsys` layout as either
 * "Task id #123" or `ActivityStack.dumpActivitiesLocked`'s `"    * " + task`,
 * i.e. "* TaskRecord{1d3813b #14418 A=com.example U=0 StackId=436 sz=2}".
 *
 * Anchored to the start of the line (issue #4263). `TaskRecord{...}` is printed
 * verbatim in at least two NON-header positions in real legacy output:
 *
 *     * Hist #1: ActivityRecord{...}
 *         frontOfTask=false task=TaskRecord{1d3813b #14418 A=... sz=2}
 *
 *     Running activities (most recent first):
 *       TaskRecord{1d3813b #14418 A=... sz=2}
 *
 * The first sits BETWEEN two `Hist` rows, so read as a header it splits one
 * task's activities across two headers and (before #4263) blanked the affinity
 * of every activity below it. Line-anchoring rejects it: it is always preceded
 * by `frontOfTask=<bool> task=`.
 *
 * The second IS at the start of its line, only without the bullet, so anchoring
 * alone cannot tell it apart from a real header -- and the bullet-less form is
 * itself pinned as a header by the #4223 suite. It is instead defused in
 * `parseTasks`, which resumes an already-seen task id rather than restarting
 * it, so a repeat cannot discard what was already parsed.
 *
 * The id is taken from the token right after the identity hash rather than by
 * the previous greedy scan, which captured the last "#number" on the line.
 */
const LEGACY_TASK_HEADER = /^\s*(?:Task\s+id\s+#(\d+)\b|\*?\s*TaskRecord\{\S+\s+#(\d+)\b(.*))$/;

/**
 * `A=` / `I=` / `aI=` out of a task-header tail. Space-anchored so "aI=" is not
 * read as "I=" and so "visibleRequested=" and friends cannot contribute a stray
 * key match; the value excludes "}" so a field printed last yields the bare
 * value rather than one with the closing brace glued on.
 */
const HEADER_AFFINITY = /(?:^|\s)A=([^\s}]+)/;
const HEADER_COMPONENT = /(?:^|\s)a?I=([^\s}]+)/;

/**
 * One printed activity: "* Hist  #0: ActivityRecord{2b2ce0f u0 pkg/.Cls t61}".
 *
 * AOSP's `ActivityRecord.toString()` always puts the user id and the component
 * INSIDE the braces, but it does NOT agree across versions on where the task id
 * goes. Both shapes are present in this repo's committed captures under
 * test/features/observe/windowDumps:
 *
 *   API 30-32, 34-36: ActivityRecord{2b2ce0f u0 com.example/.Main t61}
 *   API 33:           ActivityRecord{a9cf40f u0 com.example/.Main} t8}
 *
 * On API 33 the component is closed off by its own brace and the task id trails
 * outside it. So the component group is bounded to exclude "}" (otherwise the
 * API 33 shape yields a name ending in "}"), and the task id is scanned for
 * anywhere in the tail rather than assumed to sit at a fixed offset.
 *
 * Other trailing tokens are tolerated deliberately: a finishing activity prints
 * " f" and an activity with no task prints "t??". Requiring the task id to be
 * the last token is what made the original regex drop every line, so an
 * unrecognized tail leaves the task id to fall back to the enclosing header
 * rather than rejecting the whole activity.
 */
const ACTIVITY_LINE = /Hist\s+#(\d+):\s+ActivityRecord\{\S+\s+u\d+\s+([^\s}]+)([^\n]*\})/;

/** A parsed "Hist #N" row: its index within the task and its component. */
interface HistRow {
  /** Counts UP from the task root, so #0 is the root, not the top. */
  histIndex: number;
  /** Verbatim "pkg/.Cls" -- the same shape legacy `realActivity=` prints. */
  component: string;
  /** The row's own "tNN" token, when it carries one. */
  taskId?: number;
}

function parseHistRow(line: string): HistRow | undefined {
  const match = line.match(ACTIVITY_LINE);
  if (!match) {
    return undefined;
  }
  // Standalone "tNN" token in the tail, on either side of a closing brace.
  const taskId = match[3].match(/(?:^|[\s}])t(\d+)(?=[\s}]|$)/);
  return {
    histIndex: parseInt(match[1], 10),
    component: match[2],
    taskId: taskId ? parseInt(taskId[1], 10) : undefined,
  };
}

/**
 * Modern task header (issue #4223). `TaskFragment.dumpInner` prints
 *
 *     pw.print(prefix); pw.print("* "); pw.println(toFullString());
 *
 * and `Task.toString()` -- which `Task.toFullString()` extends -- opens with
 * "Task{" + hex identity hash + " #" + mTaskId before any optional field. The
 * id is therefore the only positionally stable token after the hash: `A=` /
 * `I=` / `aI=` are mutually exclusive and `rootTaskId=` appears only for
 * non-root tasks, so everything past the id is matched by key instead.
 *
 * The leading "* " is required. `Task{...}` also appears inline elsewhere in
 * dumpsys output (adjacent-task-fragment references, child lists), and an
 * unanchored match would invent tasks out of those references. `TaskFragment{`
 * is a different `toString()` with no "#id" and does not match "Task\{".
 *
 * Source: AOSP android15-release,
 * services/core/java/com/android/server/wm/Task.java (toString, toFullString)
 * and .../TaskFragment.java (dumpInner).
 */
const MODERN_TASK_HEADER = /^\s*\*\s*Task\{\S+\s+#(\d+)\b(.*)$/;

/** "* Hist  #0: ActivityRecord{...}" -- one printed activity. */
const HIST_LINE = /\bHist\s+#\d+:/;

/**
 * `rootOfTask=<bool>` out of an ActivityRecord block (issue #4340). Printed by
 * `ActivityRecord.dump` from API 30 on as its own field line a few lines below
 * the record's `Hist #N:` row:
 *
 *     * Hist  #1: ActivityRecord{c87b532 u0 com.google...nexuslauncher/.NexusLauncherActivity t7}
 *         ...
 *         rootOfTask=true task=Task{97acb18 #7 type=home I=...}
 *
 * This is the authoritative task-root answer; the `Hist #N` index is not. Real
 * captures disagree with the index in both directions: the launcher is the root
 * of its task yet prints as `Hist #1` on API 35/36, and API 34 prints a
 * `Hist #0` row whose block says `rootOfTask=false`. Anchored to the start of
 * the line so the inline `task=Task{...}` tail of the same line -- or any other
 * mention -- cannot match. Absent on API <= 29, where the index heuristic
 * remains the only source.
 */
const ROOT_OF_TASK_LINE = /^\s*rootOfTask=(true|false)\b/;

/**
 * The two candidate root components for a task, gathered from its `Hist` rows.
 * `firstHist0` is the index-derived value (the only source on API <= 29);
 * `authoritative` is the component whose ActivityRecord block prints
 * rootOfTask=true and, when present, is preferred (issue #4359).
 */
interface HistRootEntry {
  firstHist0?: string;
  authoritative?: string;
}

/** Fields carried by a modern task header line. */
interface TaskHeaderFields {
  id: number;
  /**
   * `Task.affinity`, verbatim. On Android 11+ this is uid-prefixed
   * ("10164:com.example") because `ActivityRecord.computeTaskAffinity`
   * prepends `uid + ":"` (b/35954083). The standalone `affinity=` line, where
   * it is printed at all, holds the identical string, so no normalization is
   * applied on either path.
   */
  affinity?: string;
  /** `I=` / `aI=` -- the task's intent component, when it has no affinity. */
  component?: string;
}

/**
 * Parse a task-header line, modern form first, then the legacy forms.
 * Returns undefined when the line is not a task header.
 */
function parseTaskHeader(line: string): TaskHeaderFields | undefined {
  const modern = line.match(MODERN_TASK_HEADER);
  if (modern) {
    return fieldsFromTail(parseInt(modern[1], 10), modern[2]);
  }

  const legacy = line.match(LEGACY_TASK_HEADER);
  if (legacy) {
    // "Task id #N" carries no fields; the "* TaskRecord{...}" form carries the
    // same A=/I=/aI= tokens as the modern header and is read the same way.
    return legacy[1] !== undefined
      ? { id: parseInt(legacy[1], 10) }
      : fieldsFromTail(parseInt(legacy[2], 10), legacy[3]);
  }

  return undefined;
}

function fieldsFromTail(id: number, tail: string): TaskHeaderFields {
  const affinity = tail.match(HEADER_AFFINITY);
  const component = tail.match(HEADER_COMPONENT);
  return {
    id,
    affinity: affinity ? affinity[1] : undefined,
    component: component ? component[1] : undefined,
  };
}

/**
 * Extracts back stack information from Android device using dumpsys activity
 */
export class GetBackStack implements BackStack {
  private adb: AdbExecutor;
  private timer: Timer;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    timer: Timer = defaultTimer,
  ) {
    this.adb = adbFactory.create(device);
    this.timer = timer;
  }

  /**
   * Parse activities from dumpsys activity activities output
   * @param dumpsysOutput - Raw dumpsys output
   * @returns Array of ActivityInfo objects
   */
  private parseActivities(dumpsysOutput: string): ActivityInfo[] {
    const activities: ActivityInfo[] = [];
    const lines = dumpsysOutput.split(/\r?\n/);

    let currentTaskId = -1;
    let currentTaskAffinity: string | undefined;
    // The last parsed activity, while the scan is still inside its
    // ActivityRecord block -- the target for that block's `rootOfTask=` line.
    // Cleared at the next Hist row or task header, so a value can never bleed
    // into the following record (issue #4340).
    let openActivity: ActivityInfo | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match the enclosing task header, legacy or modern (see parseTaskHeader).
      const header = parseTaskHeader(line);
      if (header) {
        currentTaskId = header.id;
        // A modern header carries its affinity inline; a legacy one leaves it
        // to the standalone "affinity=" line handled just below. Reset either
        // way so one task's affinity cannot leak onto the next task.
        currentTaskAffinity = header.affinity;
        openActivity = undefined;
        logger.debug(`[BACK_STACK] Found task ID: ${currentTaskId}`);
      }

      // Match task affinity
      const affinityMatch = line.match(/affinity=([^\s]+)/);
      if (affinityMatch) {
        currentTaskAffinity = affinityMatch[1];
        logger.debug(`[BACK_STACK] Found task affinity: ${currentTaskAffinity}`);
      }

      // Match activity (see ACTIVITY_LINE / parseHistRow).
      const hist = parseHistRow(line);
      if (hist) {
        const histIndex = hist.histIndex;
        const fullName = hist.component;
        const taskIdFromActivity = hist.taskId ?? currentTaskId;

        // Parse package/activity name (format: "com.example/.MainActivity" or "com.example/com.example.MainActivity")
        const parts = fullName.split("/");
        const packageName = parts[0];
        let activityName = parts[1] || "";

        // If activity starts with ".", prepend package name
        if (activityName.startsWith(".")) {
          activityName = packageName + activityName;
        }

        const activity: ActivityInfo = {
          name: activityName,
          taskId: taskIdFromActivity,
          taskAffinity: currentTaskAffinity,
          // Index-derived fallback, authoritative only on API <= 29; overridden
          // below by the block's own rootOfTask= line when one is printed.
          isTaskRoot: histIndex === 0,
        };

        activities.push(activity);
        openActivity = activity;
        logger.debug(`[BACK_STACK] Found activity: ${activityName} (task: ${taskIdFromActivity})`);
        continue;
      }

      if (HIST_LINE.test(line)) {
        // A Hist row in a shape parseHistRow does not recognize still starts a
        // new record, so the previous record's block is over; without this, the
        // unrecognized record's rootOfTask= would land on the previous activity.
        openActivity = undefined;
        continue;
      }

      // The current record's own rootOfTask= field (see ROOT_OF_TASK_LINE).
      const rootOfTask = line.match(ROOT_OF_TASK_LINE);
      if (rootOfTask && openActivity) {
        openActivity.isTaskRoot = rootOfTask[1] === "true";
        openActivity = undefined;
      }
    }

    return activities;
  }

  /**
   * Parse tasks from dumpsys activity activities output
   * @param dumpsysOutput - Raw dumpsys output
   * @returns Array of TaskInfo objects
   */
  private parseTasks(dumpsysOutput: string): TaskInfo[] {
    const tasks: Map<number, TaskInfo> = new Map();
    const lines = dumpsysOutput.split(/\r?\n/);

    let currentTaskId = -1;
    let currentTask: Partial<TaskInfo> = {};
    // Activities printed under the current header. Modern output has no
    // "numActivities=" line, and the header's "sz=" is getChildCount() -- child
    // *containers*, which for a non-leaf task counts child tasks rather than
    // activities. Counting the task's own "Hist #N" lines is correct for both.
    // Kept per task id, not per header line: legacy output prints two headers
    // for the same task ("Task id #N" then "* TaskRecord{... #N ...}"), so the
    // second must resume the first's count rather than restart it.
    const histCounts: Map<number, number> = new Map();
    // The root component of each task, derived from its `Hist` rows. `Hist #0`
    // is normally the task root (see #4197), and its "pkg/.Cls" is the same
    // shape legacy `realActivity=` prints. This is the ONLY package source on
    // the modern path (issue #4263): a modern header's `A=` is `Task.affinity`,
    // which is uid-prefixed on Android 11+, is an app-declarable string that
    // need not name a package, and is empty for `android:taskAffinity=""`. It
    // is applied at flush time, and only as a fallback, so `I=`/`aI=` and
    // `realActivity=` still win.
    //
    // `Hist #0` is not authoritative: on API 30+ a task can print two `Hist #0`
    // rows in different TaskFragments and only one's block says rootOfTask=true
    // (issue #4359, api34 task #9). `firstHist0` keeps the index-derived value
    // (the sole source on API <= 29, where rootOfTask= is absent); `authoritative`
    // captures the component whose block prints rootOfTask=true and, when set,
    // is preferred. This override only ever *replaces* a firstHist0 value -- a
    // task that prints no `Hist #0` row stays undefined even if a later `Hist #N`
    // says rootOfTask=true, matching the pre-#4359 "no Hist #0 -> no root" rule.
    const histRoots: Map<number, HistRootEntry> = new Map();
    // The still-open ActivityRecord block: the `Hist` row whose `rootOfTask=`
    // field, if printed, we are waiting on. Mirrors parseActivities' openActivity
    // discipline (issue #4340) -- cleared at the next Hist row / task header /
    // consumed rootOfTask= so a value never bleeds across records.
    let openHist: { owner: number; component: string } | undefined;

    const histRootEntry = (owner: number): HistRootEntry => {
      let entry = histRoots.get(owner);
      if (entry === undefined) {
        entry = {};
        histRoots.set(owner, entry);
      }
      return entry;
    };
    // First `Hist #0` wins; first rootOfTask=true wins. Encapsulated so the scan
    // loop stays flat (the max-depth ratchet caps nesting at 3).
    const recordFirstHist0 = (owner: number, component: string): void => {
      const entry = histRootEntry(owner);
      entry.firstHist0 ??= component;
    };
    const recordAuthoritative = (owner: number, component: string): void => {
      const entry = histRootEntry(owner);
      entry.authoritative ??= component;
    };

    const flush = (): void => {
      if (currentTaskId === -1 || currentTask.id === undefined) {
        return;
      }
      // Hist-derived fields are filled in one pass after the loop, not here: a
      // task can be flushed and then resumed by a later header for the same id,
      // and a value written here would be mistaken for an explicit one.
      tasks.set(currentTaskId, currentTask as TaskInfo);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match task start, legacy or modern (see parseTaskHeader).
      const header = parseTaskHeader(line);
      if (header) {
        flush();

        currentTaskId = header.id;
        // Resume a task we have already seen a header for rather than starting
        // it over. Legacy output prints "Task id #N" and "* TaskRecord{... #N}"
        // back to back for one task, and repeats the TaskRecord line under
        // "Running activities"; restarting there discarded everything already
        // parsed for that task (issue #4263).
        currentTask = tasks.get(currentTaskId) ?? { id: currentTaskId };
        // A task header ends the previous record's block (see openHist).
        openHist = undefined;
        if (header.affinity) {
          currentTask.affinity = header.affinity;
        }
        if (header.component) {
          currentTask.rootActivity = header.component;
          currentTask.packageName = header.component.split("/")[0];
        }
        logger.debug(`[BACK_STACK] Parsing task: ${currentTaskId}`);
      }

      if (currentTaskId === -1) {
        continue;
      }

      const hist = parseHistRow(line);
      if (hist) {
        // A row carrying its own tNN belongs to that task even when it is
        // printed under another header.
        const owner = hist.taskId ?? currentTaskId;
        histCounts.set(owner, (histCounts.get(owner) ?? 0) + 1);
        if (hist.histIndex === 0) {
          recordFirstHist0(owner, hist.component);
        }
        // This row opens a new ActivityRecord block; its own rootOfTask= (if
        // printed a few lines below) targets this row.
        openHist = { owner, component: hist.component };
      } else if (HIST_LINE.test(line)) {
        // A Hist row in a shape parseHistRow does not recognize still counts,
        // and still ends the previous record's block.
        histCounts.set(currentTaskId, (histCounts.get(currentTaskId) ?? 0) + 1);
        openHist = undefined;
      }

      // The open record's own rootOfTask= field (see ROOT_OF_TASK_LINE / #4340).
      // First rootOfTask=true wins, so the api34 double-`Hist #0` task resolves
      // to the row the dump actually marks as the root.
      const rootOfTask = line.match(ROOT_OF_TASK_LINE);
      if (rootOfTask && openHist) {
        if (rootOfTask[1] === "true") {
          recordAuthoritative(openHist.owner, openHist.component);
        }
        openHist = undefined;
      }

      // Match affinity
      const affinityMatch = line.match(/affinity=([^\s]+)/);
      if (affinityMatch) {
        currentTask.affinity = affinityMatch[1];
      }

      // Match realActivity or origActivity to get package name
      const realActivityMatch = line.match(/realActivity=([^\s]+)/);
      if (realActivityMatch) {
        const fullName = realActivityMatch[1];
        const packageName = fullName.split("/")[0];
        currentTask.packageName = packageName;

        // If this is the first activity, it's likely the root
        if (!currentTask.rootActivity) {
          currentTask.rootActivity = fullName;
        }
      }

      // Match numActivities
      const numActivitiesMatch = line.match(/numActivities=(\d+)/);
      if (numActivitiesMatch) {
        currentTask.numActivities = parseInt(numActivitiesMatch[1], 10);
      }
    }

    // Save last task
    flush();

    for (const task of tasks.values()) {
      if (task.numActivities === undefined) {
        task.numActivities = histCounts.get(task.id) ?? 0;
      }
      const entry = histRoots.get(task.id);
      // No `Hist #0` row means nothing here resolves the task's root the way
      // this fallback is scoped to. A rootOfTask=true row alone does NOT
      // populate an otherwise-undefined root (issue #4359): the override only
      // ever replaces the index-derived `firstHist0` value. Leaving both
      // undefined is the honest answer; the affinity is not a package name.
      if (entry === undefined || entry.firstHist0 === undefined) {
        continue;
      }
      const histRoot = entry.authoritative ?? entry.firstHist0;
      if (task.rootActivity === undefined) {
        task.rootActivity = histRoot;
      }
      if (task.packageName === undefined) {
        task.packageName = histRoot.split("/")[0];
      }
    }

    return Array.from(tasks.values());
  }

  /**
   * Get current/foreground activity from dumpsys output
   * @param dumpsysOutput - Raw dumpsys output
   * @returns Current ActivityInfo or undefined
   */
  private getCurrentActivity(dumpsysOutput: string): ActivityInfo | undefined {
    const lines = dumpsysOutput.split(/\r?\n/);

    for (const line of lines) {
      // Match mResumedActivity or mFocusedActivity
      // Format: "mResumedActivity: ActivityRecord{...} u0 com.example/.MainActivity t123"
      const resumedMatch = line.match(
        /(mResumedActivity|mFocusedActivity|topResumedActivity)\s*[:=].*?u\d+\s+([^\s]+)(?:\s+t(\d+))?/,
      );
      if (resumedMatch) {
        const fullName = resumedMatch[2];
        const taskId = resumedMatch[3] ? parseInt(resumedMatch[3], 10) : -1;

        const parts = fullName.split("/");
        const packageName = parts[0];
        let activityName = parts[1] || "";

        if (activityName.startsWith(".")) {
          activityName = packageName + activityName;
        }

        logger.debug(`[BACK_STACK] Current activity: ${activityName} (task: ${taskId})`);
        return {
          name: activityName,
          taskId,
        };
      }
    }

    return undefined;
  }

  /**
   * Execute dumpsys activity activities command and parse the back stack
   * @param perf - Optional performance tracker
   * @returns Promise with BackStackInfo
   */
  async execute(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<BackStackInfo> {
    const startTime = this.timer.now();

    try {
      logger.info("[BACK_STACK] Fetching back stack information via dumpsys");

      // Execute dumpsys activity activities
      const dumpsysOutput = await perf.track("dumpsysActivities", () =>
        this.adb.executeCommand(
          "shell dumpsys activity activities",
          undefined,
          undefined,
          undefined,
          signal,
        ),
      );

      // Parse activities, tasks, and current activity in parallel
      const [activities, tasks, currentActivity] = await perf.track("parseBackStack", () =>
        Promise.all([
          Promise.resolve(this.parseActivities(dumpsysOutput.stdout)),
          Promise.resolve(this.parseTasks(dumpsysOutput.stdout)),
          Promise.resolve(this.getCurrentActivity(dumpsysOutput.stdout)),
        ]),
      );

      // Calculate depth: number of activities in current task minus 1 (the current activity).
      // This is the number of entries that can still be popped from the current task.
      // isTaskRoot is set during parsing from the record's own rootOfTask= field (API 30+),
      // falling back to the "Hist #N" index -- #0 is the root -- where the field is not
      // printed (API <= 29). See ROOT_OF_TASK_LINE and issue #4340.
      const currentTaskId = currentActivity?.taskId || -1;
      const activitiesInCurrentTask = activities.filter((a) => a.taskId === currentTaskId);
      const depth = Math.max(0, activitiesInCurrentTask.length - 1);

      const backStackInfo: BackStackInfo = {
        depth,
        activities,
        tasks,
        currentActivity,
        currentTaskId,
        capturedAt: this.timer.now(),
        source: "adb",
      };

      const duration = this.timer.now() - startTime;
      logger.info(
        `[BACK_STACK] Back stack retrieved in ${duration}ms: ` +
          `depth=${depth}, activities=${activities.length}, tasks=${tasks.length}, ` +
          `currentActivity=${currentActivity?.name || "unknown"}`,
      );

      return backStackInfo;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[BACK_STACK] Failed to get back stack after ${duration}ms: ${error}`);

      // Return minimal back stack info on error
      return {
        depth: 0,
        activities: [],
        tasks: [],
        capturedAt: this.timer.now(),
        partial: true,
        source: "adb",
      };
    }
  }
}
