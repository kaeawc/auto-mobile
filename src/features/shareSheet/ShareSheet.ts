import {
  ActionableError,
  type BootedDevice,
  type ExecResult,
  type Point,
  type ViewHierarchyResult,
} from "../../models";
import { requireAndroidOrIosPlatform, type AndroidOrIosPlatform } from "../../models/Platform";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import {
  dispatchIosCoordinateTap,
  type IosCoordinateTapClient,
} from "../action/coordinateTapDispatch";
import { ORDINARY_TAP_DURATION_MS } from "../action/gestureTransportTimeout";
import { inputOnDisplay } from "../action/pressButtonDisplay";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { CHOOSER_SCAN_PAGES, swipeChooserList } from "../utility/chooserHierarchy";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { DefaultElementParser } from "../utility/ElementParser";
import { extractAndroidShareSheet } from "./androidShareSheet";
import { extractIosShareSheet } from "./iosShareSheet";
import type { SHARE_SHEET_KINDS, ShareRow, ShareTarget } from "./ShareTarget";

export interface ShareSheetRequest {
  action: "list" | "select" | "dismiss";
  appId?: string;
  label?: string;
}

interface AndroidShareSheetDevice {
  platform: "android";
  read(minTimestamp?: number, signal?: AbortSignal): Promise<ViewHierarchyResult>;
  input(
    args: string[],
    displayId: number | undefined,
    signal?: AbortSignal,
  ): Promise<Pick<ExecResult, "stderr" | "error">>;
}

interface IosShareSheetDevice {
  platform: "ios";
  read(signal?: AbortSignal): Promise<ViewHierarchyResult>;
  tap(point: Point, frameContext?: string, signal?: AbortSignal): Promise<void>;
}

export type IosShareSheetClientFactory = (device: BootedDevice) => IosCoordinateTapClient;

interface ShareSheetResult {
  success: true;
  action: ShareSheetRequest["action"];
  sheetKind: (typeof SHARE_SHEET_KINDS)[number];
  targets?: ShareTarget[];
  selected?: ShareTarget;
}

function androidShareSheetDevice(device: BootedDevice): AndroidShareSheetDevice {
  const adb = defaultAdbClientFactory.create(device);
  const hierarchy = new ViewHierarchy(device);
  return {
    platform: "android",
    async read(minTimestamp, signal) {
      const floor =
        minTimestamp ?? (await adb.getDeviceTimestampMsWithSource(3000, signal)).timestampMs;
      throwIfAborted(signal);
      const capture = await hierarchy.getViewHierarchy(undefined, {
        minTimestamp: floor,
        requireFreshExtraction: true,
        skipWaitForFresh: true,
        timeoutMs: 3000,
        signal,
      });
      requireFreshCapture(capture, floor);
      return capture;
    },
    input(args, displayId, signal) {
      return adb.executeCommand(inputOnDisplay(["shell", "input", ...args], displayId).join(" "), {
        signal,
      });
    },
  };
}

function iosShareSheetDevice(
  device: BootedDevice,
  iosClientFactory?: IosShareSheetClientFactory,
): IosShareSheetDevice {
  const hierarchy = new ViewHierarchy(device);
  return {
    platform: "ios",
    async read(signal) {
      const capture = await hierarchy.getViewHierarchy(undefined, {
        minTimestamp: defaultTimer.now(),
        skipWaitForFresh: true,
        signal,
      });
      return hierarchy.projectActionableHierarchy(capture);
    },
    async tap(point, frameContext, signal) {
      if (!iosClientFactory) {
        throw new ActionableError(
          "iOS share sheet controls require a configured iOS runner client.",
        );
      }
      await dispatchIosCoordinateTap(iosClientFactory(device), point, {
        durationMs: ORDINARY_TAP_DURATION_MS,
        frameContext,
        options: { signal },
      });
    },
  };
}

export class ShareSheet {
  private readonly parser = new DefaultElementParser();
  private readonly geometry = new DefaultElementGeometry();

  constructor(
    private readonly device: BootedDevice,
    private readonly io?: AndroidShareSheetDevice | IosShareSheetDevice,
    private readonly iosClientFactory?: IosShareSheetClientFactory,
  ) {}

  async execute(request: ShareSheetRequest, signal?: AbortSignal): Promise<ShareSheetResult> {
    const { action, appId, label } = request;
    const platform = requireAndroidOrIosPlatform(this.device.platform, "shareSheet");
    if (platform === "ios" && appId !== undefined) {
      throw new ActionableError(
        "iOS shareSheet selects by label. Omit appId and use shareSheet list to find the exact label.",
      );
    }
    if (
      action === "select"
        ? Boolean(appId) === Boolean(label)
        : appId !== undefined || label !== undefined
    ) {
      throw new ActionableError(
        "For select, provide exactly one non-empty appId or label. For list or dismiss, omit both.",
      );
    }
    throwIfAborted(signal);
    if (platform === "ios") {
      const io =
        this.io?.platform === "ios"
          ? this.io
          : iosShareSheetDevice(this.device, this.iosClientFactory);
      return this.executeIos(io, request, signal);
    }

    const io = this.io?.platform === "android" ? this.io : androidShareSheetDevice(this.device);
    return this.executeAndroid(io, request, signal);
  }

  private async executeAndroid(
    io: AndroidShareSheetDevice,
    { action, appId, label }: ShareSheetRequest,
    signal?: AbortSignal,
  ): Promise<ShareSheetResult> {
    const hierarchy = await awaitWhileRequestIsLive(io.read(undefined, signal), signal);
    const sheet = this.requireSheet(hierarchy);
    const result = { success: true, action, sheetKind: sheet.sheetKind } as const;

    if (action === "list") {
      return { ...result, targets: sheet.rows.map(({ target }) => target) };
    }
    if (action === "dismiss") {
      await this.sendInput(io, hierarchy, ["keyevent", "KEYCODE_BACK"], signal);
      return result;
    }

    const selected = await this.select(io, { hierarchy, sheet }, { appId, label }, signal);
    return { ...result, selected };
  }

  private async executeIos(
    io: IosShareSheetDevice,
    { action, label }: ShareSheetRequest,
    signal?: AbortSignal,
  ): Promise<ShareSheetResult> {
    const hierarchy = await awaitWhileRequestIsLive(io.read(signal), signal);
    requireFreshCapture(hierarchy, undefined, "ios");
    const sheet = extractIosShareSheet(hierarchy, this.parser, this.geometry);
    if (!sheet) {
      throw sheetNotShowing("iOS");
    }
    const result = { success: true, action, sheetKind: sheet.sheetKind } as const;
    if (action === "list") {
      return { ...result, targets: sheet.rows.map(({ target }) => target) };
    }
    if (action === "dismiss") {
      if (!sheet.dismissPoint) {
        throw new ActionableError(
          'The iOS share sheet has no tappable "dismiss popup" region. Observe the screen and close the share sheet using its visible controls.',
        );
      }
      await this.tapIos(io, hierarchy, sheet.dismissPoint, signal);
      return result;
    }

    const matches = sheet.rows.filter(({ target }) => target.label === label);
    if (matches.length > 1) {
      throw ambiguousTarget(label, matches, "Use a unique label.");
    }
    const match = matches[0];
    if (!match) {
      throw new ActionableError(
        `No share target matches ${JSON.stringify(label)}. Run shareSheet list to see current labels.`,
      );
    }
    await this.tapIos(io, hierarchy, this.geometry.getElementCenter(match.element), signal);
    return { ...result, selected: match.target };
  }

  private async tapIos(
    io: IosShareSheetDevice,
    hierarchy: ViewHierarchyResult,
    point: Point,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(io.tap(point, hierarchy.frameContext, signal), signal);
  }

  private async select(
    io: AndroidShareSheetDevice,
    initial: { hierarchy: ViewHierarchyResult; sheet: ReturnType<ShareSheet["requireSheet"]> },
    { appId, label }: Pick<ShareSheetRequest, "appId" | "label">,
    signal?: AbortSignal,
  ): Promise<ShareTarget> {
    let { hierarchy, sheet } = initial;
    const selector = appId ?? label;
    for (let page = 0; page < CHOOSER_SCAN_PAGES; page++) {
      const matches = sheet.rows.filter(({ target, primaryLabel }) =>
        appId !== undefined
          ? target.appId === appId
          : target.label === label || primaryLabel === label,
      );
      if (matches.length > 1) {
        throw ambiguousTarget(selector, matches, "Use a unique label or verified appId.");
      }
      const match = matches[0];
      if (match) {
        const { x, y } = this.geometry.getElementCenter(match.element);
        await this.sendInput(io, hierarchy, ["tap", String(x), String(y)], signal);
        return match.target;
      }
      if (page === CHOOSER_SCAN_PAGES - 1) {
        break;
      }
      const fresh = await swipeChooserList(hierarchy, sheet.list.bounds, {
        signal,
        swipe: (args, signal) => io.input(args, hierarchy.displayId ?? undefined, signal),
        read: (minTimestamp, signal) => io.read(minTimestamp, signal),
        validate: (next, minTimestamp) => {
          requireFreshCapture(next, minTimestamp);
          if (
            next.packageName !== hierarchy.packageName ||
            (next.displayId ?? undefined) !== (hierarchy.displayId ?? undefined)
          ) {
            throw new ActionableError(
              "The Android share sheet changed while scrolling. Reopen it from the app and retry.",
            );
          }
        },
      });
      if (!fresh) {
        break;
      }
      hierarchy = fresh;
      sheet = this.requireSheet(hierarchy);
    }

    throw new ActionableError(
      `No share target matches ${JSON.stringify(selector)}. Run shareSheet list to see current labels and verified appIds.`,
    );
  }

  private requireSheet(hierarchy: ViewHierarchyResult) {
    requireFreshCapture(hierarchy);
    const sheet = extractAndroidShareSheet(hierarchy, this.parser);
    if (!sheet) {
      throw sheetNotShowing("Android");
    }
    return sheet;
  }

  private async sendInput(
    io: AndroidShareSheetDevice,
    hierarchy: ViewHierarchyResult,
    args: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const result = await awaitWhileRequestIsLive(
      io.input(args, hierarchy.displayId ?? undefined, signal),
      signal,
    );
    const failure = result.error || result.stderr.trim();
    if (failure) {
      throw new ActionableError(
        `Android share sheet input failed: ${failure}. Observe the screen before retrying.`,
      );
    }
  }
}

function requireFreshCapture(
  hierarchy: ViewHierarchyResult,
  minTimestamp?: number,
  platform: AndroidOrIosPlatform = "android",
): void {
  const platformName = platform === "ios" ? "iOS" : "Android";
  if (hierarchy.hierarchy.error || hierarchy.ctrlProxyIncomplete) {
    const detail = hierarchy.hierarchy.error ?? "the capture was incomplete";
    throw new ActionableError(
      `Could not read the ${platformName} share sheet: ${detail}. Observe the screen and retry.`,
    );
  }
  if (
    hierarchy.fresh === false ||
    (minTimestamp !== undefined && (hierarchy.updatedAt ?? -Infinity) < minTimestamp)
  ) {
    throw new ActionableError(
      `The ${platformName} share sheet hierarchy did not refresh. Observe the screen and retry.`,
    );
  }
}

function sheetNotShowing(platform: "Android" | "iOS"): ActionableError {
  return new ActionableError(
    `The ${platform} share sheet is not showing. Open it from the app under test and retry.`,
  );
}

function ambiguousTarget(
  selector: string | undefined,
  matches: ShareRow[],
  guidance: string,
): ActionableError {
  const candidates = matches.map(({ target, element }) => ({
    ...target,
    bounds: element.bounds,
  }));
  return new ActionableError(
    `Ambiguous share target ${JSON.stringify(selector)}. Candidates: ${JSON.stringify(candidates)}. ${guidance}`,
  );
}
