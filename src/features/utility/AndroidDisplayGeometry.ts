import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { invalidateDisplayCaches } from "../observe/DisplayTransition";
import { parseOverlayList } from "./DisplayProfile";
import {
  defaultDisplayProfileRestoreRegistry,
  type DisplayProfileRestoreRegistry,
} from "./DisplayProfileRestore";
import {
  MAX_ANDROID_DISPLAY_SCALE,
  MIN_ANDROID_DISPLAY_SIDE_PX,
  availableOverlayValues,
  effectiveSize,
  enabledOverlays,
  formatSize,
  groupOverlays,
  overlayCommands,
  overlayTargetFor,
  overlayValue,
  parseWmSize,
  restorableSize,
  sameSize,
  wmSizeReadCommand,
  wmSizeWriteCommand,
  type DisplayCutoutInput,
  type DisplaySizeInput,
  type NavigationModeInput,
  type OverlayEntry,
  type OverlayGroup,
  type WmSize,
} from "./androidDisplayGeometryCommands";

/** The runtime display geometry displayConfig reads and sets on Android (#14101). */
export interface DisplayGeometryValues {
  /** Size override in pixels (natural orientation), or `"default"` for the physical size. */
  size?: DisplaySizeInput;
  navigationMode?: NavigationModeInput;
  displayCutout?: DisplayCutoutInput;
}

export type DisplayGeometryInput = DisplayGeometryValues;

export const DISPLAY_GEOMETRY_FIELDS = ["size", "navigationMode", "displayCutout"] as const;

/** The navigation-mode and cutout values this system image ships overlays for. */
export interface DisplayGeometryAvailability {
  navigationMode: string[];
  displayCutout: string[];
}

export interface DisplayGeometrySupport {
  size: boolean | "partial";
  navigationMode: boolean;
  displayCutout: boolean;
}

export interface DisplayGeometryOptions {
  /** Logical display id that `size` targets; the default display when omitted. */
  displayId?: number;
  /** The session whose release restores what this call changes. */
  owner?: string;
  /** The restore record shared with `displayProfile`, so one release restores both. */
  registry?: DisplayProfileRestoreRegistry;
  /** Clears observation, screenshot and coordinate caches after the geometry moved. */
  invalidate?: (deviceId: string, reason: string) => void;
}

export interface DisplayGeometryRead {
  /** Effective size and overlay values; fields that could not be read are omitted. */
  values: DisplayGeometryValues;
  available?: DisplayGeometryAvailability;
}

interface OverlayStep {
  group: OverlayGroup;
  target: string[];
}

/** A validated geometry change: the state read before it and what it will write. */
export interface PreparedDisplayGeometry {
  previous: DisplayGeometryValues;
  available?: DisplayGeometryAvailability;
  size?: { current: WmSize; target: DisplaySizeInput };
  overlays?: { entries: OverlayEntry[]; steps: OverlayStep[] };
}

export interface DisplayGeometryChange {
  previous: DisplayGeometryValues;
  applied?: DisplayGeometryValues;
  available?: DisplayGeometryAvailability;
  errors: string[];
}

export const GEOMETRY_ANDROID_ONLY_ERROR =
  "size, navigationMode and displayCutout are Android only (`wm size` and `cmd overlay`).";

const GROUP_LABELS: Record<OverlayGroup, string> = {
  navigationMode: "Navigation mode",
  displayCutout: "Display cutout",
};

/** The displayProfile restore facet each overlay group is recorded under. */
const GROUP_FACETS = { navigationMode: "navigationMode", displayCutout: "cutout" } as const;

const DEFAULT_DISPLAY_SCOPE = "0";

const SAFE_OVERLAY_NAME = /^[A-Za-z0-9_.:]+$/;

const GEOMETRY_FACETS: readonly string[] = ["screenSize", "navigationMode", "cutout"];

/** Listing the `android` target keeps the call small; it holds every navbar and cutout overlay. */
const OVERLAY_LIST_COMMAND = "shell cmd overlay list android";

export function hasDisplayGeometryField(input: DisplayGeometryInput): boolean {
  return DISPLAY_GEOMETRY_FIELDS.some((field) => input[field] !== undefined);
}

/** The rest of a request once the geometry fields are taken out; a false `reset` is no request. */
export function withoutGeometryFields<T extends DisplayGeometryInput & { reset?: boolean }>(
  input: T,
): Omit<T, keyof DisplayGeometryInput> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        value !== undefined &&
        !(DISPLAY_GEOMETRY_FIELDS as readonly string[]).includes(key) &&
        !(key === "reset" && value === false),
    ),
  ) as Omit<T, keyof DisplayGeometryInput>;
}

/** Size is reliable on emulators; OEM shells may clamp or ignore `wm size` on hardware. */
export function displayGeometrySupport(device: BootedDevice): DisplayGeometrySupport {
  const android = device.platform === "android";
  return {
    size: android ? (isAndroidEmulatorSerial(device.deviceId) ? true : "partial") : false,
    navigationMode: android,
    displayCutout: android,
  };
}

function overlayValues(entries: readonly OverlayEntry[]): DisplayGeometryValues {
  const navigationMode = overlayValue("navigationMode", enabledOverlays(entries, "navigationMode"));
  const displayCutout = overlayValue("displayCutout", enabledOverlays(entries, "displayCutout"));
  return {
    ...(navigationMode === undefined
      ? {}
      : { navigationMode: navigationMode as NavigationModeInput }),
    ...(displayCutout === undefined ? {} : { displayCutout: displayCutout as DisplayCutoutInput }),
  };
}

function availability(entries: readonly OverlayEntry[]): DisplayGeometryAvailability {
  return {
    navigationMode: availableOverlayValues(entries, "navigationMode"),
    displayCutout: availableOverlayValues(entries, "displayCutout"),
  };
}

/**
 * Runtime screen size (`wm size`), navigation mode and display-cutout emulation
 * (`cmd overlay`) for one Android device (#14101). Requests are validated against the
 * overlays the system image ships before anything is written. Each slot a change touches
 * records its original in the `displayProfile` restore registry first, so `reset`, a
 * `displayProfile` reset and session release all put it back.
 */
export class AndroidDisplayGeometry {
  private readonly registry: DisplayProfileRestoreRegistry;
  private readonly invalidate: (deviceId: string, reason: string) => void;

  constructor(
    private readonly device: BootedDevice,
    private readonly adb: AdbCommandRunner,
    private readonly options: DisplayGeometryOptions = {},
  ) {
    this.registry = options.registry ?? defaultDisplayProfileRestoreRegistry;
    this.invalidate = options.invalidate ?? invalidateDisplayCaches;
  }

  private get displayId(): number {
    return this.options.displayId ?? 0;
  }

  private async run(command: string): Promise<string> {
    const result = await this.adb.executeCommand(command, { noRetry: true });
    if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
      throw new Error(`'${command}' reported: ${`${result.stdout} ${result.stderr ?? ""}`.trim()}`);
    }
    return result.stdout;
  }

  private async runChecked(command: string, setting: string): Promise<string[]> {
    try {
      await this.run(command);
      return [];
    } catch (error) {
      logger.warn(`[DisplayGeometry] ${setting} command failed: ${errorMessage(error)}`, error);
      return [`${setting}: '${command}' failed: ${errorMessage(error)}`];
    }
  }

  private async readSize(): Promise<WmSize> {
    const raw = await this.run(wmSizeReadCommand(this.options.displayId));
    const size = parseWmSize(raw);
    if (size === undefined) {
      throw new Error(`could not parse 'wm size' output: ${raw.trim() || "(empty)"}`);
    }
    return size;
  }

  /** Every overlay of the navbar and cutout groups; an empty listing is a failed read. */
  private async readOverlays(): Promise<OverlayEntry[]> {
    // Names flow into shell commands: keep only package-shaped names (`user:pkg` included).
    const entries = parseOverlayList(await this.run(OVERLAY_LIST_COMMAND))
      .filter((overlay) => SAFE_OVERLAY_NAME.test(overlay.name))
      .map((overlay) => ({ packageName: overlay.name, enabled: overlay.enabled }));
    if (entries.length === 0) {
      throw new Error("could not parse 'cmd overlay list' output");
    }
    return entries;
  }

  /** Best-effort read for the displayConfig getter: an unreadable part is logged and omitted. */
  async read(): Promise<DisplayGeometryRead> {
    const [size, overlays] = await Promise.allSettled([this.readSize(), this.readOverlays()]);
    const values: DisplayGeometryValues = {};
    if (size.status === "fulfilled") {
      values.size = effectiveSize(size.value);
    } else {
      logger.warn(`[DisplayGeometry] size read failed: ${errorMessage(size.reason)}`, size.reason);
    }
    if (overlays.status === "rejected") {
      logger.warn(
        `[DisplayGeometry] overlay read failed: ${errorMessage(overlays.reason)}`,
        overlays.reason,
      );
      return { values };
    }
    return {
      values: { ...values, ...overlayValues(overlays.value) },
      available: availability(overlays.value),
    };
  }

  /**
   * Read the current state and validate the request against it. Returns a refusal (and changes
   * nothing) when a needed read fails, a size is out of range, or an overlay is not shipped.
   */
  async prepare(
    input: DisplayGeometryInput,
  ): Promise<PreparedDisplayGeometry | { refusal: string }> {
    const steps = this.overlaySteps(input);
    try {
      const prepared: PreparedDisplayGeometry = { previous: {} };
      if (input.size !== undefined) {
        const current = await this.readSize();
        const refusal = this.sizeRefusal(input.size, current);
        if (refusal) {
          return { refusal };
        }
        prepared.size = { current, target: input.size };
        prepared.previous.size = restorableSize(current);
      }
      if (steps.length > 0) {
        const entries = await this.readOverlays();
        const refusal = this.overlayRefusal(input, entries);
        if (refusal) {
          return { refusal };
        }
        prepared.overlays = { entries, steps };
        prepared.available = availability(entries);
        Object.assign(prepared.previous, overlayValues(entries));
      }
      return prepared;
    } catch (error) {
      logger.warn(`[DisplayGeometry] pre-read failed: ${errorMessage(error)}`, error);
      return { refusal: `Could not read the display geometry: ${errorMessage(error)}` };
    }
  }

  private overlaySteps(input: DisplayGeometryInput): OverlayStep[] {
    return (["navigationMode", "displayCutout"] as const).flatMap((group) => {
      const value = input[group];
      return value === undefined ? [] : [{ group, target: overlayTargetFor(group, value) }];
    });
  }

  private sizeRefusal(target: DisplaySizeInput, current: WmSize): string | undefined {
    if (target === "default" || current.physical === undefined) {
      return undefined;
    }
    const { width, height } = current.physical;
    const maxWidth = width * MAX_ANDROID_DISPLAY_SCALE;
    const maxHeight = height * MAX_ANDROID_DISPLAY_SCALE;
    if (
      target.width < MIN_ANDROID_DISPLAY_SIDE_PX ||
      target.height < MIN_ANDROID_DISPLAY_SIDE_PX ||
      target.width > maxWidth ||
      target.height > maxHeight
    ) {
      return (
        `Cannot set display size ${formatSize(target)}: Android clamps each side to ` +
        `${MIN_ANDROID_DISPLAY_SIDE_PX}..${MAX_ANDROID_DISPLAY_SCALE}x the physical size ` +
        `(${MIN_ANDROID_DISPLAY_SIDE_PX}-${maxWidth} x ${MIN_ANDROID_DISPLAY_SIDE_PX}-${maxHeight} px ` +
        `for this ${formatSize(current.physical)} display, natural orientation).`
      );
    }
    return undefined;
  }

  private overlayRefusal(
    input: DisplayGeometryInput,
    entries: readonly OverlayEntry[],
  ): string | undefined {
    const refusals = (["navigationMode", "displayCutout"] as const).flatMap((group) => {
      const value = input[group];
      const available = availableOverlayValues(entries, group);
      return value === undefined || available.includes(value)
        ? []
        : [
            `${group} '${value}' is not available on this system image; its overlays allow: ` +
              `${available.join(", ")}.`,
          ];
    });
    return refusals.length > 0 ? refusals.join(" ") : undefined;
  }

  /** Write a prepared change, then verify it with a fresh read. Failures are collected, not thrown. */
  async apply(prepared: PreparedDisplayGeometry): Promise<DisplayGeometryChange> {
    const errors: string[] = [];
    const sizeDispatched = await this.applySize(prepared.size, errors);
    const overlaysDispatched = await this.applyOverlays(prepared.overlays, errors);
    if (sizeDispatched || overlaysDispatched) {
      this.invalidate(this.device.deviceId, "Display geometry changed by displayConfig");
    }
    const applied = await this.verify(prepared, errors);
    return {
      previous: prepared.previous,
      ...(applied ? { applied } : {}),
      ...(prepared.available ? { available: prepared.available } : {}),
      errors,
    };
  }

  /** Returns whether a command was dispatched; a no-op target records and sends nothing. */
  private async applySize(
    size: PreparedDisplayGeometry["size"],
    errors: string[],
  ): Promise<boolean> {
    if (!size || sameSize(restorableSize(size.current), size.target)) {
      return false;
    }
    // Record before dispatch: even a rejected write can leave the display resized.
    this.registry.record(
      this.device,
      {
        facet: "screenSize",
        commands: [wmSizeWriteCommand(restorableSize(size.current), this.options.displayId)],
        scopes: [String(this.displayId)],
      },
      this.options.owner,
    );
    const command = wmSizeWriteCommand(size.target, this.options.displayId);
    errors.push(...(await this.runChecked(command, "size")));
    return true;
  }

  private async applyOverlays(
    overlays: PreparedDisplayGeometry["overlays"],
    errors: string[],
  ): Promise<boolean> {
    let dispatched = false;
    for (const step of overlays?.steps ?? []) {
      const entries = overlays?.entries ?? [];
      const current = enabledOverlays(entries, step.group);
      const commands = overlayCommands(current, step.target);
      if (commands.length > 0) {
        this.recordOverlayOriginal(entries, step.group, current);
        dispatched = true;
      }
      for (const command of commands) {
        const failure = await this.runChecked(command, step.group);
        errors.push(...failure);
        if (failure.length > 0) {
          break;
        }
      }
    }
    return dispatched;
  }

  /**
   * The restore for a group puts back the original overlays and disables every other overlay of
   * the group, so a later change to a third value cannot leave its overlay enabled.
   */
  private recordOverlayOriginal(
    entries: readonly OverlayEntry[],
    group: OverlayGroup,
    original: readonly string[],
  ): void {
    const every = groupOverlays(entries, group).map((entry) => entry.packageName);
    this.registry.record(
      this.device,
      { facet: GROUP_FACETS[group], commands: overlayCommands(every, original) },
      this.options.owner,
    );
  }

  /** Re-read what was written and report mismatches. */
  private async verify(
    prepared: PreparedDisplayGeometry,
    errors: string[],
  ): Promise<DisplayGeometryValues | undefined> {
    const applied: DisplayGeometryValues = {};
    try {
      if (prepared.size) {
        const after = await this.readSize();
        applied.size = effectiveSize(after);
        const actual = prepared.size.target === "default" ? restorableSize(after) : applied.size;
        if (!sameSize(actual, prepared.size.target)) {
          errors.push(
            `Display size remained ${formatSize(actual)} after requesting ${formatSize(prepared.size.target)}.`,
          );
        }
      }
      if (prepared.overlays) {
        const after = await this.readOverlays();
        Object.assign(applied, overlayValues(after));
        for (const step of prepared.overlays.steps) {
          this.verifyOverlayStep(step, enabledOverlays(after, step.group), errors);
        }
      }
      return applied;
    } catch (error) {
      logger.warn(`[DisplayGeometry] post-read failed: ${errorMessage(error)}`, error);
      errors.push(`failed to read applied display geometry: ${errorMessage(error)}`);
      return Object.keys(applied).length > 0 ? applied : undefined;
    }
  }

  private verifyOverlayStep(step: OverlayStep, enabled: string[], errors: string[]): void {
    if (overlayCommands(enabled, step.target).length > 0) {
      errors.push(
        `${GROUP_LABELS[step.group]} remained ${String(overlayValue(step.group, enabled) ?? enabled.join(", "))} ` +
          `after requesting ${String(overlayValue(step.group, step.target) ?? step.target.join(", "))}.`,
      );
    }
  }

  /**
   * Put back what displayConfig or displayProfile changed: every recorded size, navigation-mode
   * and cutout original, and the target display's size when nothing recorded it (a leftover
   * override from a lost record must not outlive a reset). Recorded facets are forgotten once
   * restored; one that fails stays recorded for the next reset or the session's release.
   */
  async reset(): Promise<DisplayGeometryChange> {
    const errors: string[] = [];
    const before = await this.snapshot();
    const recorded = this.registry
      .pending(this.device.deviceId)
      .flatMap((action) =>
        "commands" in action && GEOMETRY_FACETS.includes(action.facet) ? [action] : [],
      );
    const scope = String(this.displayId);
    let sizeRecorded = false;
    for (const action of recorded) {
      // A size record holds one command per display (`commands[i]` restores `scopes[i]`): only
      // the targeted display is restored here, the others stay recorded for their own reset.
      const scopes = action.scopes ?? [DEFAULT_DISPLAY_SCOPE];
      const mine = action.facet === "screenSize" ? scopes.indexOf(scope) : -1;
      if (action.facet === "screenSize" && mine < 0) {
        continue;
      }
      sizeRecorded ||= action.facet === "screenSize";
      const commands = action.facet === "screenSize" ? [action.commands[mine]] : action.commands;
      if (!(await this.runAll(commands, action.facet, errors))) {
        if (action.facet === "screenSize") {
          this.registry.forgetScopes(this.device.deviceId, action.facet, [scope]);
        } else {
          this.registry.forget(this.device.deviceId, action.facet);
        }
      }
    }
    if (!sizeRecorded) {
      await this.runAll([wmSizeWriteCommand("default", this.options.displayId)], "size", errors);
    }
    this.invalidate(this.device.deviceId, "Display geometry reset by displayConfig");
    const after = await this.snapshot();
    return {
      previous: before,
      ...(Object.keys(after).length > 0 ? { applied: after } : {}),
      errors,
    };
  }

  /** Run commands in order; returns true when one failed (the rest are skipped). */
  private async runAll(
    commands: readonly string[],
    setting: string,
    errors: string[],
  ): Promise<boolean> {
    for (const command of commands) {
      const failure = await this.runChecked(command, setting);
      errors.push(...failure);
      if (failure.length > 0) {
        return true;
      }
    }
    return false;
  }

  /** Best-effort restorable state for reset's previous/applied; unreadable parts are omitted. */
  private async snapshot(): Promise<DisplayGeometryValues> {
    const [size, overlays] = await Promise.allSettled([this.readSize(), this.readOverlays()]);
    return {
      ...(size.status === "fulfilled" ? { size: restorableSize(size.value) } : {}),
      ...(overlays.status === "fulfilled" ? overlayValues(overlays.value) : {}),
    };
  }
}
