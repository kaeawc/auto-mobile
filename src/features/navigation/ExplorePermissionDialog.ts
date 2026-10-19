import { isTruthy, type BootedDevice, type ObserveResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { logger } from "../../utils/logger";
import type { ProgressCallback } from "../action/BaseVisualChange";
import {
  handlePermissionDialog,
  isConfirmedPermissionDialogForNavigation,
  isPermissionDialog,
  type BlockerHandlerDeps,
} from "./ExploreBlockerDetection";
import { extractAllElements, getElementKey } from "./ExploreElementExtraction";
interface PermissionDialogDependencies {
  elementParser: ElementParser;
  device: BootedDevice;
  adb: AdbExecutor;
  blockerHandlerDeps: BlockerHandlerDeps;
  maxConsecutiveNoChange: number;
  incrementNoChange(): void;
  resetNoChange(): void;
  getNoChange(): number;
  shouldBreakForSafety(): boolean;
}
const MAX_PERMISSION_DIALOG_TAP_ATTEMPTS = 3;
/** Bounds retries for the same permission dialog without losing stuck-screen accounting. */
export class ExplorePermissionDialog {
  private permissionDialogIdentity: string | null = null;
  private permissionDialogTapAttempts = 0;
  reset(): void {
    this.permissionDialogIdentity = null;
    this.permissionDialogTapAttempts = 0;
  }
  /**
   * Detect and act on a permission dialog at the top of the exploration loop.
   *
   * Returns:
   * - `"continue"` when the dialog was granted (screen changed) or the no-op of
   *   an ungrantable dialog was accounted for and the loop should re-observe;
   * - `"break"` when an ungrantable (e.g. deny-only) dialog has stalled the
   *   screen long enough to trip the stuck-screen accounting;
   * - `"none"` when no permission dialog is present.
   *
   * A dialog exposing no safe affirmative control (e.g. only "Don't allow") can
   * neither be granted nor have its deny control tapped (issue #6241). The
   * previous fast-path discarded that outcome and always continued, so
   * exploration re-observed the same unchanged dialog until the timeout. Counting
   * the no-op lets the existing stuck-screen accounting stop the run instead
   * (partially addresses issue #6169).
   */
  async handle(
    observation: ObserveResult,
    deps: PermissionDialogDependencies,
    progress?: ProgressCallback,
  ): Promise<"continue" | "break" | "none"> {
    const viewHierarchy = observation.viewHierarchy;
    if (!viewHierarchy || viewHierarchy.hierarchy.error) {
      return "none";
    }
    const elements = extractAllElements(viewHierarchy, deps.elementParser);
    if (!isPermissionDialog(elements) || !isConfirmedPermissionDialogForNavigation(elements)) {
      return "none";
    }

    const identity = elements
      .filter((element) => isTruthy(element.clickable))
      .map((element) => getElementKey(element, viewHierarchy))
      .sort()
      .join("|");
    if (identity !== this.permissionDialogIdentity) {
      this.permissionDialogIdentity = identity;
      this.permissionDialogTapAttempts = 0;
    }
    if (this.permissionDialogTapAttempts >= MAX_PERMISSION_DIALOG_TAP_ATTEMPTS) {
      deps.incrementNoChange();
      logger.warn(
        `[Explore] Permission dialog tap cap reached for identity "${identity}" ` +
          `(${this.permissionDialogTapAttempts}/${MAX_PERMISSION_DIALOG_TAP_ATTEMPTS})`,
      );
      if (deps.shouldBreakForSafety()) {
        logger.warn("[Explore] Unresolvable permission dialog treated as blocker, stopping");
        return "break";
      }
      return "continue";
    }
    this.permissionDialogTapAttempts++;

    logger.info("[Explore] Detected permission dialog, attempting to dismiss");
    const granted = await handlePermissionDialog(
      elements,
      viewHierarchy,
      deps.device,
      deps.adb,
      progress,
      deps.blockerHandlerDeps,
    );
    if (granted) {
      deps.resetNoChange();
      return "continue";
    }

    deps.incrementNoChange();
    logger.warn(
      `[Explore] Permission dialog could not be granted (deny-only); counted as no-op ` +
        `(${deps.getNoChange()}/${deps.maxConsecutiveNoChange})`,
    );
    if (deps.shouldBreakForSafety()) {
      logger.warn("[Explore] Unresolvable permission dialog treated as blocker, stopping");
      return "break";
    }
    return "continue";
  }
}
