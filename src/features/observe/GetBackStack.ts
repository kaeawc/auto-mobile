import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BackStackInfo, ActivityInfo, TaskInfo, BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import type { BackStack } from "./interfaces/BackStack";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

/**
 * Legacy task header, printed by `TaskRecord.toString()` / the pre-Android-10
 * `dumpsys` layout: "Task id #123" or "TaskRecord{task123 #123 A=... sz=3}".
 */
const LEGACY_TASK_HEADER = /Task\s+id\s+#(\d+)|TaskRecord.*#(\d+)/;

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
    const tail = modern[2];
    // Space-anchored so "aI=" is not read as "I=", and so "visibleRequested="
    // and friends cannot contribute a stray key match.
    // The value is bounded to exclude "}" so a field printed last still yields
    // the bare value rather than one with the closing brace glued on.
    const affinity = tail.match(/(?:^|\s)A=([^\s}]+)/);
    const component = tail.match(/(?:^|\s)a?I=([^\s}]+)/);
    return {
      id: parseInt(modern[1], 10),
      affinity: affinity ? affinity[1] : undefined,
      component: component ? component[1] : undefined
    };
  }

  const legacy = line.match(LEGACY_TASK_HEADER);
  if (legacy) {
    return { id: parseInt(legacy[1] || legacy[2], 10) };
  }

  return undefined;
}

/**
 * Extracts back stack information from Android device using dumpsys activity
 */
export class GetBackStack implements BackStack {
  private adb: AdbExecutor;
  private timer: Timer;

  constructor(device: BootedDevice, adbFactory: AdbClientFactory = defaultAdbClientFactory, timer: Timer = defaultTimer) {
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
    const lines = dumpsysOutput.split("\n");

    let currentTaskId = -1;
    let currentTaskAffinity: string | undefined;

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
        logger.debug(`[BACK_STACK] Found task ID: ${currentTaskId}`);
      }

      // Match task affinity
      const affinityMatch = line.match(/affinity=([^\s]+)/);
      if (affinityMatch) {
        currentTaskAffinity = affinityMatch[1];
        logger.debug(`[BACK_STACK] Found task affinity: ${currentTaskAffinity}`);
      }

      // Match activity. AOSP's ActivityRecord.toString() always puts the user id
      // and the component INSIDE the braces, but it does NOT agree across
      // versions on where the task id goes. Both shapes are present in this
      // repo's committed captures under test/features/observe/windowDumps:
      //
      //   API 30-32, 34-36: ActivityRecord{2b2ce0f u0 com.example/.Main t61}
      //   API 33:           ActivityRecord{a9cf40f u0 com.example/.Main} t8}
      //
      // On API 33 the component is closed off by its own brace and the task id
      // trails outside it. So the component group is bounded to exclude "}"
      // (otherwise the API 33 shape yields a name ending in "}"), and the task
      // id is scanned for anywhere in the tail rather than assumed to sit at a
      // fixed offset. The "Hist #N" index counts up from the task root, so #0
      // is the task root and the highest index is the topmost activity.
      //
      // Other trailing tokens are tolerated deliberately: a finishing activity
      // prints " f" and an activity with no task prints "t??". Requiring the
      // task id to be the last token is what made the original regex drop every
      // line, so an unrecognized tail leaves the task id to fall back to the
      // enclosing task header rather than rejecting the whole activity.
      const activityMatch = line.match(
        /Hist\s+#(\d+):\s+ActivityRecord\{\S+\s+u\d+\s+([^\s}]+)([^\n]*\})/
      );
      if (activityMatch) {
        const histIndex = parseInt(activityMatch[1], 10);
        const fullName = activityMatch[2];
        // Standalone "tNN" token in the tail, on either side of a closing brace.
        const taskIdMatchFromActivity = activityMatch[3].match(/(?:^|[\s}])t(\d+)(?=[\s}]|$)/);
        const taskIdFromActivity = taskIdMatchFromActivity
          ? parseInt(taskIdMatchFromActivity[1], 10)
          : currentTaskId;

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
          isTaskRoot: histIndex === 0
        };

        activities.push(activity);
        logger.debug(`[BACK_STACK] Found activity: ${activityName} (task: ${taskIdFromActivity})`);
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
    const lines = dumpsysOutput.split("\n");

    let currentTaskId = -1;
    let currentTask: Partial<TaskInfo> = {};
    // Activities printed under the current header. Modern output has no
    // "numActivities=" line, and the header's "sz=" is getChildCount() -- child
    // *containers*, which for a non-leaf task counts child tasks rather than
    // activities. Counting the task's own "Hist #N" lines is correct for both.
    let histCount = 0;

    const flush = (): void => {
      if (currentTaskId === -1 || currentTask.id === undefined) {
        return;
      }
      if (currentTask.numActivities === undefined) {
        currentTask.numActivities = histCount;
      }
      tasks.set(currentTaskId, currentTask as TaskInfo);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match task start, legacy or modern (see parseTaskHeader).
      const header = parseTaskHeader(line);
      if (header) {
        flush();

        currentTaskId = header.id;
        currentTask = { id: currentTaskId };
        histCount = 0;
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

      if (HIST_LINE.test(line)) {
        histCount++;
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

    return Array.from(tasks.values());
  }

  /**
   * Get current/foreground activity from dumpsys output
   * @param dumpsysOutput - Raw dumpsys output
   * @returns Current ActivityInfo or undefined
   */
  private getCurrentActivity(dumpsysOutput: string): ActivityInfo | undefined {
    const lines = dumpsysOutput.split("\n");

    for (const line of lines) {
      // Match mResumedActivity or mFocusedActivity
      // Format: "mResumedActivity: ActivityRecord{...} u0 com.example/.MainActivity t123"
      const resumedMatch = line.match(
        /(mResumedActivity|mFocusedActivity|topResumedActivity)\s*[:=].*?u\d+\s+([^\s]+)(?:\s+t(\d+))?/
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
          taskId
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
    signal?: AbortSignal
  ): Promise<BackStackInfo> {
    const startTime = this.timer.now();

    try {
      logger.info("[BACK_STACK] Fetching back stack information via dumpsys");

      // Execute dumpsys activity activities
      const dumpsysOutput = await perf.track("dumpsysActivities", () =>
        this.adb.executeCommand("shell dumpsys activity activities", undefined, undefined, undefined, signal)
      );

      // Parse activities, tasks, and current activity in parallel
      const [activities, tasks, currentActivity] = await perf.track("parseBackStack", () =>
        Promise.all([
          Promise.resolve(this.parseActivities(dumpsysOutput.stdout)),
          Promise.resolve(this.parseTasks(dumpsysOutput.stdout)),
          Promise.resolve(this.getCurrentActivity(dumpsysOutput.stdout))
        ])
      );

      // Calculate depth: number of activities in current task minus 1 (the current activity).
      // This is the number of entries that can still be popped from the current task.
      // isTaskRoot is set during parsing from the activity's own "Hist #N" index -- the
      // root is the #0 entry, which dumpsys prints LAST because it lists top-to-bottom.
      const currentTaskId = currentActivity?.taskId || -1;
      const activitiesInCurrentTask = activities.filter(a => a.taskId === currentTaskId);
      const depth = Math.max(0, activitiesInCurrentTask.length - 1);

      const backStackInfo: BackStackInfo = {
        depth,
        activities,
        tasks,
        currentActivity,
        currentTaskId,
        capturedAt: this.timer.now(),
        source: "adb"
      };

      const duration = this.timer.now() - startTime;
      logger.info(
        `[BACK_STACK] Back stack retrieved in ${duration}ms: ` +
        `depth=${depth}, activities=${activities.length}, tasks=${tasks.length}, ` +
        `currentActivity=${currentActivity?.name || "unknown"}`
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
        source: "adb"
      };
    }
  }
}
