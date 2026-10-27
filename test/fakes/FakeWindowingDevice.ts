import type { BackStackInfo, ElementBounds, ExecResult, TaskInfo } from "../../src/models";
import type {
  AdbCommandRunner,
  AdbExecuteOptions,
} from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BackStack } from "../../src/features/observe/interfaces/BackStack";
import { createExecResult } from "../../src/utils/execResult";

type CommandRule = { pattern: RegExp; respond: (match: RegExpMatchArray) => string | void };

/**
 * An Android device's task windowing state behind the two seams `windowMode` uses (#14115):
 * the adb shell (`AdbCommandRunner`) and the parsed `dumpsys activity activities`
 * (`BackStack`). Settings, boot id, API level and launcher resolution answer by default;
 * each test adds rules for the windowing commands its scenario's device honors.
 */
export class FakeWindowingDevice implements AdbCommandRunner, BackStack {
  readonly commands: string[] = [];
  readonly settings = new Map<string, string>();
  apiLevel = 34;
  bootId = "0f3c2a5e-8f0b-4c1d-9a6e-2b7d4e1c9f30";
  currentTaskId?: number;
  private tasks: TaskInfo[] = [];
  private readonly rules: CommandRule[] = [];
  private readonly launcherActivities = new Map<string, string>();
  private nextTaskId = 100;

  addTask(packageName: string, windowingMode: string, bounds?: ElementBounds): TaskInfo {
    const task: TaskInfo = {
      id: this.nextTaskId++,
      packageName,
      numActivities: 1,
      windowingMode,
      ...(bounds ? { bounds } : {}),
    };
    this.tasks.unshift(task);
    this.currentTaskId = task.id;
    this.launcherActivities.set(packageName, `${packageName}/.MainActivity`);
    return task;
  }

  installApp(packageName: string): void {
    this.launcherActivities.set(packageName, `${packageName}/.MainActivity`);
  }

  task(packageName: string): TaskInfo | undefined {
    return this.tasks.find((task) => task.packageName === packageName);
  }

  /** Moves a package's task to the top and resumes it. */
  bringToFront(packageName: string): TaskInfo {
    const task = this.task(packageName) ?? this.addTask(packageName, "fullscreen", FULL_SCREEN);
    this.tasks = [task, ...this.tasks.filter((other) => other !== task)];
    this.currentTaskId = task.id;
    return task;
  }

  setWindow(packageName: string, windowingMode: string, bounds?: ElementBounds): void {
    const task = this.bringToFront(packageName);
    task.windowingMode = windowingMode;
    if (bounds) {
      task.bounds = bounds;
    } else {
      delete task.bounds;
    }
  }

  on(pattern: RegExp, respond: CommandRule["respond"]): void {
    this.rules.push({ pattern, respond });
  }

  async executeCommand(command: string, options: AdbExecuteOptions = {}): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    this.commands.push(command);
    return createExecResult(this.respond(command.replace(/^shell /, "")), "");
  }

  async execute(_perf?: unknown, signal?: AbortSignal): Promise<BackStackInfo> {
    signal?.throwIfAborted();
    const current = this.tasks.find((task) => task.id === this.currentTaskId);
    return {
      depth: 0,
      activities: [],
      tasks: this.tasks.map((task) => ({ ...task })),
      ...(current
        ? { currentActivity: { name: `${current.packageName}.MainActivity`, taskId: current.id } }
        : {}),
      currentTaskId: this.currentTaskId,
      source: "adb",
    };
  }

  private respond(command: string): string {
    for (const rule of this.rules) {
      const match = command.match(rule.pattern);
      if (match) {
        return rule.respond(match) ?? "";
      }
    }
    return this.builtIn(command);
  }

  private builtIn(command: string): string {
    const setting = command.match(/^settings (get|put|delete) global (\S+)(?: '?(\d+)'?)?$/);
    if (setting) {
      const [, verb, key, value] = setting;
      if (verb === "get") {
        return this.settings.get(key) ?? "null";
      }
      if (verb === "put") {
        this.settings.set(key, value);
      } else {
        this.settings.delete(key);
      }
      return "";
    }
    if (command === "cat /proc/sys/kernel/random/boot_id") {
      return this.bootId;
    }
    if (command === "getprop ro.build.version.sdk") {
      return String(this.apiLevel);
    }
    const resolve = command.match(/^cmd package resolve-activity --brief .* '([^']+)'$/);
    if (resolve) {
      const component = this.launcherActivities.get(resolve[1]);
      return component
        ? `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${component}`
        : "No activity found";
    }
    return "";
  }
}

export const FULL_SCREEN: ElementBounds = { left: 0, top: 0, right: 1080, bottom: 2400 };
