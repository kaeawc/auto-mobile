import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BackStackInfo, ActivityInfo, TaskInfo, BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import type { BackStack } from "./interfaces/BackStack";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

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

      // Match task affinity: "Task id #123" or "TaskRecord{...} #123"
      const taskIdMatch = line.match(/Task\s+id\s+#(\d+)|TaskRecord.*#(\d+)/);
      if (taskIdMatch) {
        currentTaskId = parseInt(taskIdMatch[1] || taskIdMatch[2], 10);
        logger.debug(`[BACK_STACK] Found task ID: ${currentTaskId}`);
      }

      // Match task affinity
      const affinityMatch = line.match(/affinity=([^\s]+)/);
      if (affinityMatch) {
        currentTaskAffinity = affinityMatch[1];
        logger.debug(`[BACK_STACK] Found task affinity: ${currentTaskAffinity}`);
      }

      // Match activity. AOSP's ActivityRecord.toString() puts the user id, the
      // component and the task id INSIDE the braces, e.g.
      //   "* Hist  #0: ActivityRecord{2b2ce0f u0 com.example/.MainActivity t61}"
      // The "Hist #N" index counts up from the task root, so #0 is the task
      // root and the highest index is the topmost (visible) activity.
      const activityMatch = line.match(
        /Hist\s+#(\d+):\s+ActivityRecord\{\S+\s+u\d+\s+(\S+)(?:\s+t(\d+))?\}/
      );
      if (activityMatch) {
        const histIndex = parseInt(activityMatch[1], 10);
        const fullName = activityMatch[2];
        const taskIdFromActivity = activityMatch[3] ? parseInt(activityMatch[3], 10) : currentTaskId;

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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match task start: "Task id #123" or "TaskRecord{...} #123"
      const taskIdMatch = line.match(/Task\s+id\s+#(\d+)|TaskRecord.*#(\d+)/);
      if (taskIdMatch) {
        // Save previous task if it exists
        if (currentTaskId !== -1 && currentTask.id !== undefined) {
          tasks.set(currentTaskId, currentTask as TaskInfo);
        }

        currentTaskId = parseInt(taskIdMatch[1] || taskIdMatch[2], 10);
        currentTask = { id: currentTaskId };
        logger.debug(`[BACK_STACK] Parsing task: ${currentTaskId}`);
      }

      if (currentTaskId === -1) {
        continue;
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
    if (currentTaskId !== -1 && currentTask.id !== undefined) {
      tasks.set(currentTaskId, currentTask as TaskInfo);
    }

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
