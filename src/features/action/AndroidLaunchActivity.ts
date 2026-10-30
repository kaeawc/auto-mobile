import { rethrowDeviceTransportUnavailable } from "../../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BootedDevice } from "../../models";
import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";
import { adbFailureOutput } from "../../utils/android-cmdline-tools/adbFailureOutput";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { errorMessage } from "../../utils/describeUnknownError";
import { shellQuote } from "../../utils/shellQuote";
import {
  AndroidLaunchIntentError,
  buildAmStartIntentArgs,
  classifyAmStartFailure,
  resolveIntentComponent,
  type AndroidLaunchIntent,
} from "./androidLaunchIntent";
import {
  parseLauncherActivities,
  parseLauncherActivitiesFromPackageDump,
  resolveComponentActivity,
} from "./launcherActivityParsing";

const LAUNCHER_CATEGORY = "android.intent.category.LAUNCHER";
/** Launcher categories in resolution order; TV-only apps declare only the leanback one. */
const LAUNCHER_CATEGORIES = [LAUNCHER_CATEGORY, "android.intent.category.LEANBACK_LAUNCHER"];

/** The abort signal and optional explicit intent for one Android launch. */
export interface AndroidPerformLaunchOptions {
  signal?: AbortSignal;
  intent?: AndroidLaunchIntent;
}

/** Budget for the Android a11y service to answer a launch-intent request. */
const A11Y_LAUNCH_INTENT_TIMEOUT_MS = 3_000;
export function amStartReportedFailure(stdout: string, stderr: string): boolean {
  return (
    /^Error(?::| type \d+)/m.test(`${stdout}\n${stderr}`) ||
    /does not exist/i.test(`${stdout}\n${stderr}`)
  );
}
interface AndroidLaunchActivityDependencies {
  device: BootedDevice;
  adb: Pick<AdbExecutor, "executeCommand">;
  failFastWhenPackageRemoved: (
    packageName: string,
    userId: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ) => Promise<void>;
}
/** Android launcher resolution and ordered intent, monkey and activity fallbacks. */
export class AndroidLaunchActivity {
  constructor(private readonly deps: AndroidLaunchActivityDependencies) {}
  private assertLaunchNotAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
  }

  private async extractLauncherActivities(
    packageName: string,
    userId: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    this.assertLaunchNotAborted(signal);
    logger.info("extractLauncherActivities");
    const resolvedActivities = await this.tryResolveViaCtrlProxy(packageName, perf, signal);
    if (resolvedActivities) {
      return resolvedActivities;
    }
    const activities: string[] = [];

    try {
      logger.info(`[LaunchApp] Extracting launcher activities for ${packageName}`);
      const approaches = this.buildActivityApproachCommands(packageName, userId);
      for (let i = 0; i < approaches.length; i++) {
        this.assertLaunchNotAborted(signal);
        activities.push(
          ...(await this.runActivityApproach(approaches[i], i, packageName, perf, signal)),
        );
        if (activities.length > 0) {
          break;
        }
      }

      if (activities.length === 0) {
        this.assertLaunchNotAborted(signal);
        logger.info(`[LaunchApp] No activities found, trying fallback approach`);
        activities.push(...(await this.runActivityFallback(packageName, perf, signal)));
      }
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      this.assertLaunchNotAborted(signal);
      logger.warn(`[LaunchApp] Failed to extract launcher activities for ${packageName}:`, error);
    }

    logger.info(`[LaunchApp] Final activities list: [${activities.join(", ")}]`);
    return activities;
  }

  private async tryResolveViaCtrlProxy(
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[] | undefined> {
    // Try the WebSocket-backed PackageManager launch intent first.
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.deps.device);
      const result = perf
        ? await perf.track("a11yLaunchIntent", () =>
            a11y.requestLaunchIntent(packageName, A11Y_LAUNCH_INTENT_TIMEOUT_MS),
          )
        : await a11y.requestLaunchIntent(packageName, A11Y_LAUNCH_INTENT_TIMEOUT_MS);
      this.assertLaunchNotAborted(signal);
      if (result.success && result.componentName) {
        const activity = resolveComponentActivity(result.componentName, packageName);
        if (activity !== undefined) {
          logger.info(`[LaunchApp] Resolved launcher activity via a11y: ${activity}`);
          return [activity];
        }
      }
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      this.assertLaunchNotAborted(signal);
      // A missing CtrlProxy launch intent can still be resolved through PackageManager over ADB.
      logger.debug(`[LaunchApp] a11y launch intent failed, falling back to ADB: ${error}`);
    }
    return undefined;
  }

  private buildActivityApproachCommands(packageName: string, userId: number): string[] {
    // Keep handheld resolution first; TV-only apps may expose only Leanback (#15957).
    return LAUNCHER_CATEGORIES.map(
      (category) =>
        `shell cmd package query-activities --brief --user ${userId} -a android.intent.action.MAIN -c ${category} | grep ${shellQuote(packageName)}`,
    );
  }

  private async runActivityApproach(
    command: string,
    index: number,
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      logger.info(`[LaunchApp] Trying approach ${index + 1}: ${command}`);
      const result = perf
        ? await perf.track(`activityApproach_${index + 1}`, () =>
            this.deps.adb.executeCommand(command, { signal }),
          )
        : await this.deps.adb.executeCommand(command, { signal });
      this.assertLaunchNotAborted(signal);
      logger.info(
        `[LaunchApp] Approach ${index + 1} result: ${result.stdout.length} chars of output`,
      );
      const activities = parseLauncherActivities(result.stdout, packageName);
      if (activities.length > 0) {
        logger.info(
          `[LaunchApp] Successfully found ${activities.length} activities using approach ${index + 1}`,
        );
      }
      return activities;
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      this.assertLaunchNotAborted(signal);
      logger.warn(`[LaunchApp] Approach ${index + 1} failed:`, error);
    }
    return [];
  }

  private async runActivityFallback(
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      const simpleResult = perf
        ? await perf.track("activityFallback", () =>
            this.deps.adb.executeCommand(`shell pm dump ${shellQuote(packageName)}`, { signal }),
          )
        : await this.deps.adb.executeCommand(`shell pm dump ${shellQuote(packageName)}`, {
            signal,
          });
      this.assertLaunchNotAborted(signal);
      const activities = parseLauncherActivitiesFromPackageDump(simpleResult.stdout, packageName);
      for (const activity of activities) {
        logger.info(`[LaunchApp] Added fallback activity: ${activity}`);
      }
      return activities;
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      this.assertLaunchNotAborted(signal);
      logger.warn(`[LaunchApp] Fallback approach failed:`, error);
    }
    return [];
  }

  /**
   * The package's launcher component and the category that resolved it. A TV-only app declares
   * only LEANBACK_LAUNCHER (#15957), so that category is tried when LAUNCHER resolves nothing.
   */
  private async resolveAndroidLauncherTarget(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ component: string; category: string } | undefined> {
    for (const category of LAUNCHER_CATEGORIES) {
      const component = await this.resolveAndroidLauncherComponent(
        packageName,
        userId,
        category,
        signal,
      );
      if (component) {
        return { component, category };
      }
    }
    return undefined;
  }

  private async resolveAndroidLauncherComponent(
    packageName: string,
    userId: number,
    category: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const command = `shell cmd package resolve-activity --brief --user ${userId} -c ${category} ${shellQuote(packageName)}`;
    try {
      const result = await this.deps.adb.executeCommand(command);
      this.assertLaunchNotAborted(signal);
      const lastLine = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      const componentMatch = lastLine?.match(/^([^/\s]+)\/([^/\s]+)$/);
      const [, componentPackage, componentActivity] = componentMatch ?? [];
      if (!componentPackage || !componentActivity || componentPackage !== packageName) {
        return undefined;
      }
      const component = `${componentPackage}/${componentActivity}`;
      return resolveComponentActivity(component, packageName) ? component : undefined;
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      this.assertLaunchNotAborted(signal);
      // Older Android versions may lack this resolver; the bare intent remains the fallback.
      logger.debug(`[LaunchApp] Launcher component resolution unavailable: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async tryAndroidIntentLaunch(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; amReportedError?: boolean }> {
    logger.info(`[LaunchApp] Trying am start with intent for user ${userId}`);
    try {
      const resolved = await this.resolveAndroidLauncherTarget(packageName, userId, signal);
      this.assertLaunchNotAborted(signal);
      const launcherTarget = resolved
        ? `-n ${shellQuote(resolved.component)}`
        : shellQuote(packageName);
      const category = resolved?.category ?? LAUNCHER_CATEGORY;
      const intentCmd = `shell am start --user ${userId} -a android.intent.action.MAIN -c ${category} ${launcherTarget}`;
      logger.info(`[LaunchApp] Intent command: ${intentCmd}`);
      const result = await this.deps.adb.executeCommand(intentCmd);
      this.assertLaunchNotAborted(signal);
      // am start may report launch errors on stderr while still returning exit code 0.
      if (result.stdout && !result.stdout.includes("Error") && !result.stderr.includes("Error")) {
        logger.info(`[LaunchApp] Intent launch completed successfully`);
        return { success: true };
      }
      logger.info(`[LaunchApp] Intent launch returned error: ${result.stdout}${result.stderr}`);
      // Classified from am's own output; the echoed intent (and its package) is not searched.
      return {
        success: false,
        amReportedError: amStartReportedFailure(result.stdout, result.stderr),
      };
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      this.assertLaunchNotAborted(signal);
      logger.warn(
        `[LaunchApp] Intent launch failed: ${errorMessage(error)}, falling back to monkey`,
      );
      // A non-zero exit from `am start` rejects the call; classify am's own output, not the
      // message, so a transport failure (no output of its own) is not read as an am error.
      const output = adbFailureOutput(error);
      return {
        success: false,
        amReportedError: amStartReportedFailure(output.stdout, output.stderr),
      };
    }
  }

  /**
   * An explicit intent (#14080) has no fallbacks: a monkey or launcher launch would open a
   * different screen than the one asked for, so an `am start` refusal is a typed failure.
   */
  private async launchExplicitIntent(
    packageName: string,
    intent: AndroidLaunchIntent,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; packageName: string; activityName?: string; userId: number }> {
    const command = `shell am start --user ${userId} ${buildAmStartIntentArgs(packageName, intent)}`;
    logger.info(`[LaunchApp] Explicit intent command: ${command}`);
    let output: string;
    try {
      const result = await this.deps.adb.executeCommand(command);
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      this.assertLaunchNotAborted(signal);
      const failed = adbFailureOutput(error);
      output = `${failed.stdout}\n${failed.stderr}`;
      const typed = classifyAmStartFailure(output);
      throw typed ?? new AndroidLaunchIntentError("am_start_failed", errorMessage(error));
    }
    this.assertLaunchNotAborted(signal);
    const failure = classifyAmStartFailure(output);
    if (failure) {
      throw failure;
    }
    return {
      success: true,
      packageName,
      activityName: intent.component
        ? resolveIntentComponent(packageName, intent.component)
        : undefined,
      userId,
    };
  }

  private async tryAndroidMonkeyLaunch(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean }> {
    logger.info(`[LaunchApp] Trying monkey launch (fallback approach) for user ${userId}`);
    try {
      const monkeyCmd = `shell monkey -p ${shellQuote(packageName)} -c android.intent.category.LAUNCHER 1`;
      logger.info(`[LaunchApp] Monkey command: ${monkeyCmd}`);
      const result = await this.deps.adb.executeCommand(monkeyCmd);
      this.assertLaunchNotAborted(signal);
      if (
        /No activities found to run|[Mm]onkey aborted/.test(`${result.stdout}\n${result.stderr}`)
      ) {
        logger.info(`[LaunchApp] Monkey launch reported no activity`);
        return { success: false };
      }
      logger.info(`[LaunchApp] Monkey launch completed successfully`);
      return { success: true };
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      this.assertLaunchNotAborted(signal);
      logger.warn(
        `[LaunchApp] Monkey launch failed: ${errorMessage(error)}, falling back to activity discovery`,
      );
      return { success: false };
    }
  }

  /** Monkey cannot target a user, so it only runs for user 0. */
  private async tryMonkeyFallback(
    packageName: string,
    userId: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (userId !== 0) {
      logger.info(
        `[LaunchApp] Skipping monkey for user ${userId}: monkey cannot target a user; continuing to activity discovery`,
      );
      return false;
    }
    const monkeyResult = await perf.track("monkeyLaunch", () =>
      this.tryAndroidMonkeyLaunch(packageName, userId, signal),
    );
    this.assertLaunchNotAborted(signal);
    return monkeyResult.success;
  }

  async performLaunch(
    packageName: string,
    activityName: string | undefined,
    userId: number,
    perf: PerformanceTracker,
    options: AndroidPerformLaunchOptions = {},
  ): Promise<{ success: boolean; packageName: string; activityName?: string; userId: number }> {
    const { signal, intent } = options;
    this.assertLaunchNotAborted(signal);
    if (intent) {
      const launched = await perf.track("explicitIntentLaunch", () =>
        this.launchExplicitIntent(packageName, intent, userId, signal),
      );
      perf.end();
      return launched;
    }
    return this.performDiscoveredLaunch(packageName, activityName, userId, perf, signal);
  }

  /** Launch without an explicit intent: intent, monkey, then launcher-activity discovery. */
  private async performDiscoveredLaunch(
    packageName: string,
    activityName: string | undefined,
    userId: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; packageName: string; activityName?: string; userId: number }> {
    let targetActivity = activityName;

    // Try am start with intent first (alternative to monkey)
    if (!targetActivity) {
      const intentResult = await perf.track("intentLaunch", () =>
        this.tryAndroidIntentLaunch(packageName, userId, signal),
      );
      this.assertLaunchNotAborted(signal);

      if (intentResult.success) {
        perf.end();
        return {
          success: true,
          packageName,
          activityName: "intent_launch",
          userId,
        };
      }
      if (intentResult.amReportedError) {
        await this.deps.failFastWhenPackageRemoved(packageName, userId, perf, signal);
      }
    }

    // Try monkey launch as fallback (fast but less reliable)
    if (!targetActivity && (await this.tryMonkeyFallback(packageName, userId, perf, signal))) {
      perf.end();
      return {
        success: true,
        packageName,
        activityName: "monkey_launch",
        userId,
      };
    }

    // If no specific activity provided, get launcher activities from pm dump
    if (!targetActivity) {
      const launcherActivities = await perf.track("extractLauncherActivities", async () => {
        logger.info(`[LaunchApp] No activity specified, extracting launcher activities`);
        return this.extractLauncherActivities(packageName, userId, perf, signal);
      });
      this.assertLaunchNotAborted(signal);

      if (launcherActivities.length > 0) {
        targetActivity = launcherActivities[0];
        logger.info(`[LaunchApp] Using first found activity: ${targetActivity}`);
      } else {
        // Try common activity name patterns
        const patternResult = await perf.track("tryCommonPatterns", async () => {
          logger.info(`[LaunchApp] No launcher activities found, trying common patterns`);
          const commonPatterns = [
            `${packageName}.MainActivity`,
            `${packageName}.ui.MainActivity`,
            `${packageName}.main.MainActivity`,
            `${packageName}.activity.MainActivity`,
            `${packageName}.LauncherActivity`,
            `${packageName}.MainLauncherActivity`,
          ];

          for (const pattern of commonPatterns) {
            this.assertLaunchNotAborted(signal);
            try {
              logger.info(`[LaunchApp] Trying common pattern: ${pattern}`);
              const result = await this.deps.adb.executeCommand(
                `shell am start --user ${userId} -n ${shellQuote(`${packageName}/${pattern}`)}`,
              );
              this.assertLaunchNotAborted(signal);
              if (amStartReportedFailure(result.stdout, result.stderr)) {
                logger.info(`[LaunchApp] Pattern ${pattern} reported an activity error`);
                continue;
              }
              logger.info(`[LaunchApp] Successfully launched with pattern: ${pattern}`);
              return { success: true, pattern };
            } catch (error) {
              rethrowDeviceTransportUnavailable(error);
              this.assertLaunchNotAborted(signal);
              // A missing conventional activity name does not rule out the next candidate.
              logger.debug(`[LaunchApp] Pattern ${pattern} failed: ${error}`);
            }
          }
          return { success: false, pattern: null };
        });
        this.assertLaunchNotAborted(signal);

        if (patternResult.success && patternResult.pattern) {
          perf.end();
          return {
            success: true,
            packageName,
            activityName: patternResult.pattern,
            userId,
          };
        }
      }
    }

    // Launch with specific activity if found, otherwise use default method
    if (targetActivity) {
      await perf.track("launchActivity", async () => {
        logger.info(`[LaunchApp] Launching with activity: ${targetActivity} for user ${userId}`);
        const launchCmd = `shell am start --user ${userId} -n ${shellQuote(`${packageName}/${targetActivity}`)}`;
        logger.info(`[LaunchApp] Launch command: ${launchCmd}`);
        await this.deps.adb.executeCommand(launchCmd);
        this.assertLaunchNotAborted(signal);
        logger.info(`[LaunchApp] Launch command completed successfully`);
      });
    } else {
      // Fallback to launcher intent
      await perf.track("launcherIntent", async () => {
        logger.info(`[LaunchApp] No activity found, trying launcher intent for user ${userId}`);
        try {
          const launcherCmd = `shell am start --user ${userId} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shellQuote(packageName)}`;
          logger.info(`[LaunchApp] Launcher intent command: ${launcherCmd}`);
          const result = await this.deps.adb.executeCommand(launcherCmd);
          this.assertLaunchNotAborted(signal);
          if (amStartReportedFailure(result.stdout, result.stderr)) {
            throw new ActionableError("No launcher activity found and launcher intent failed");
          }
          logger.info(`[LaunchApp] Launcher intent completed successfully`);
        } catch (error) {
          rethrowDeviceTransportUnavailable(error);
          this.assertLaunchNotAborted(signal);
          logger.error(`[LaunchApp] Launcher intent failed: ${error}`);
          throw new ActionableError("No launcher activity found and launcher intent failed");
        }
      });
    }

    logger.info(`[LaunchApp] Launch completed successfully`);
    perf.end();
    return {
      success: true,
      packageName,
      activityName: targetActivity,
      userId,
    };
  }
}
