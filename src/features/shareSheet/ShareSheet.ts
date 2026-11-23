import {
  ActionableError,
  type BootedDevice,
  type ExecResult,
  type Point,
  type ViewHierarchyResult,
} from "../../models";
import { requireAndroidOrIosPlatform, type AndroidOrIosPlatform } from "../../models/Platform";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import {
  dispatchIosCoordinateTap,
  type IosCoordinateTapClient,
} from "../action/coordinateTapDispatch";
import { ORDINARY_TAP_DURATION_MS } from "../action/gestureTransportTimeout";
import { inputOnDisplay } from "../action/pressButtonDisplay";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import type { HierarchyCapture, HierarchyCaptureRequest } from "../observe/HierarchyCapture";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { isSessionlessDeviceRead } from "../toolSelection/toolSelectionContext";
import {
  CHOOSER_SCAN_PAGES,
  expandChooserSheet,
  swipeChooserList,
} from "../utility/chooserHierarchy";
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
  tap(point: Point, signal?: AbortSignal): Promise<void>;
}

type AndroidSheet = NonNullable<ReturnType<typeof extractAndroidShareSheet>>;
type AndroidShareRow = AndroidSheet["rows"][number];
interface AndroidSheetPage {
  hierarchy: ViewHierarchyResult;
  sheet: AndroidSheet;
}

const AMBIGUITY_GUIDANCE = "Use a unique label or verified appId.";
const SCROLL_TOLERANCE_PX = 2;
/**
 * After a swipe, the list's overscroll stretch keeps animating with no change in the hierarchy,
 * and RecyclerView takes a touch that lands during it as a drag that stops the animation instead
 * of a click, so the tap reported success but opened nothing (#14246, API 37 device check).
 */
const SWIPE_SETTLE_MS = 500;

function targetKey({ label, appId, kind }: ShareTarget): string {
  return JSON.stringify([label, appId ?? null, kind]);
}

function rowKey(row: AndroidShareRow): string {
  return JSON.stringify([targetKey(row.target), row.primaryLabel ?? null]);
}

/**
 * The intentresolver suggested-apps row repeats targets that the full app list below it also
 * shows, so a suggested row with the same labels as a full-list row is that row, not a second
 * candidate. Two full-list rows with one label stay ambiguous.
 */
function withoutSuggestedRepeats(rows: AndroidShareRow[]): AndroidShareRow[] {
  const listed = new Set(rows.filter((row) => !row.suggested).map(rowKey));
  return rows.filter((row) => !row.suggested || !listed.has(rowKey(row)));
}

function uniqueRowsByKey(sheet: AndroidSheet): Map<string, AndroidShareRow> {
  const counts = new Map<string, AndroidShareRow[]>();
  for (const row of sheet.rows) {
    const key = targetKey(row.target);
    counts.set(key, [...(counts.get(key) ?? []), row]);
  }
  return new Map(
    [...counts].filter(([, rows]) => rows.length === 1).map(([key, [row]]) => [key, row]),
  );
}

/**
 * True when `match` on the page after a scroll is the previous page's match carried along
 * by the scroll (viewport overlap) or pinned in place, rather than another row with the
 * same label. The scroll distance comes from the other rows visible on both pages.
 */
function isSameRowAfterScroll(
  previous: { sheet: AndroidSheet; match?: AndroidShareRow },
  sheet: AndroidSheet,
  match: AndroidShareRow,
): boolean {
  const key = targetKey(match.target);
  const old = previous.match?.element.bounds;
  if (
    !previous.match ||
    !old ||
    targetKey(previous.match.target) !== key ||
    Math.abs(old.left - match.element.bounds.left) > SCROLL_TOLERANCE_PX
  ) {
    return false;
  }
  const moved = old.top - match.element.bounds.top;
  // Copy and other actions can sit outside the scrolling list.
  if (moved === 0 && match.target.kind === "action") {
    return true;
  }
  // Only rows the scroll moved can measure it (#18872): a pinned action, or any row that stayed
  // in place, matches a zero offset whatever the list did, and would vouch for a different
  // same-label row that happens to sit where the match was.
  const before = uniqueRowsByKey(previous.sheet);
  return [...uniqueRowsByKey(sheet)].some(([otherKey, row]) => {
    const old = before.get(otherKey);
    if (otherKey === key || old === undefined || row.target.kind === "action") {
      return false;
    }
    const rowMoved = old.element.bounds.top - row.element.bounds.top;
    return (
      Math.abs(rowMoved) > SCROLL_TOLERANCE_PX && Math.abs(rowMoved - moved) <= SCROLL_TOLERANCE_PX
    );
  });
}

export type IosShareSheetClientFactory = (device: BootedDevice) => IosCoordinateTapClient;

interface ShareSheetResult {
  success: true;
  action: ShareSheetRequest["action"];
  sheetKind: (typeof SHARE_SHEET_KINDS)[number];
  targets?: ShareTarget[];
  selected?: ShareTarget;
}

export type ShareSheetCaptureFactory = (device: BootedDevice) => HierarchyCapture;

interface ShareSheetDeps {
  iosClientFactory?: IosShareSheetClientFactory;
  captureFactory?: ShareSheetCaptureFactory;
  timer?: Timer;
}

/**
 * A sessionless `list` (#10830) reads through the isolated observer capture, so a caller that
 * does not hold the device only connects to a running hierarchy service and never drives the
 * holder's resident client into its runner or service setup.
 */
async function observerRead(
  device: BootedDevice,
  captureFactory: ShareSheetCaptureFactory,
  request: Pick<HierarchyCaptureRequest, "minTimestamp" | "timeoutMs" | "signal">,
): Promise<ViewHierarchyResult> {
  const snapshot = await captureFactory(device).capture({
    freshness: "fresh",
    observerMode: true,
    ...request,
  });
  return snapshot.hierarchy;
}

function androidShareSheetDevice(
  device: BootedDevice,
  captureFactory: ShareSheetCaptureFactory,
): AndroidShareSheetDevice {
  const adb = defaultAdbClientFactory.create(device);
  const hierarchy = isSessionlessDeviceRead() ? undefined : new ViewHierarchy(device);
  return {
    platform: "android",
    async read(minTimestamp, signal) {
      if (!hierarchy) {
        // The observer capture's "fresh" request supplies its own freshness proof.
        const capture = await observerRead(device, captureFactory, {
          minTimestamp,
          timeoutMs: 3000,
          signal,
        });
        requireFreshCapture(capture, minTimestamp);
        return capture;
      }
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
  captureFactory: ShareSheetCaptureFactory,
  iosClientFactory?: IosShareSheetClientFactory,
): IosShareSheetDevice {
  const hierarchy = isSessionlessDeviceRead() ? undefined : new ViewHierarchy(device);
  return {
    platform: "ios",
    async read(signal) {
      if (!hierarchy) {
        return observerRead(device, captureFactory, { minTimestamp: defaultTimer.now(), signal });
      }
      const capture = await hierarchy.getViewHierarchy(undefined, {
        minTimestamp: defaultTimer.now(),
        skipWaitForFresh: true,
        signal,
      });
      return hierarchy.projectActionableHierarchy(capture);
    },
    async tap(point, signal) {
      if (!iosClientFactory) {
        throw new ActionableError(
          "iOS share sheet controls require a configured iOS runner client.",
        );
      }
      await dispatchIosCoordinateTap(iosClientFactory(device), point, {
        durationMs: ORDINARY_TAP_DURATION_MS,
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
    private readonly deps: ShareSheetDeps = {},
  ) {}

  private get timer(): Timer {
    return this.deps.timer ?? defaultTimer;
  }

  private get captureFactory(): ShareSheetCaptureFactory {
    return this.deps.captureFactory ?? createDeviceHierarchyCapture;
  }

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
          : iosShareSheetDevice(this.device, this.captureFactory, this.deps.iosClientFactory);
      return this.executeIos(io, request, signal);
    }

    const io =
      this.io?.platform === "android"
        ? this.io
        : androidShareSheetDevice(this.device, this.captureFactory);
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
      await this.tapIos(io, sheet.dismissPoint, signal);
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
    await this.tapIos(io, this.geometry.getElementCenter(match.element), signal);
    return { ...result, selected: match.target };
  }

  private async tapIos(io: IosShareSheetDevice, point: Point, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    // Like tapOn, send no frame context: the runner rejects the token from this skip-wait
    // read as stale on iOS 27, although the sheet the point came from is still showing.
    await awaitWhileRequestIsLive(io.tap(point, signal), signal);
  }

  private async select(
    io: AndroidShareSheetDevice,
    initial: AndroidSheetPage,
    { appId, label }: Pick<ShareSheetRequest, "appId" | "label">,
    signal?: AbortSignal,
  ): Promise<ShareTarget> {
    const selector = appId ?? label;
    const pageMatch = (sheet: AndroidSheet): AndroidShareRow | undefined => {
      const matches = withoutSuggestedRepeats(
        sheet.rows.filter(({ target, primaryLabel }) =>
          appId !== undefined
            ? target.appId === appId
            : target.label === label || primaryLabel === label,
        ),
      );
      if (matches.length > 1) {
        throw ambiguousTarget(selector, matches, AMBIGUITY_GUIDANCE);
      }
      return matches[0];
    };

    // Refuse a label repeated on the visible page before moving the sheet at all.
    pageMatch(initial.sheet);
    // Rows below a collapsed sheet's first row are hidden until the sheet is dragged open.
    const start = (await this.expandSheet(io, initial, signal)) ?? initial;
    const scan = await this.scanForMatch(io, start, { pageMatch, selector }, signal);
    // Every matching row in the scanned list is the one candidate. The forward scan may
    // have moved it off screen, so scroll back until it reappears.
    let current = scan.last;
    for (let back = 0; ; back++) {
      if (pageMatch(current.sheet)) {
        // The scan always swipes at least once before this tap.
        throwIfAborted(signal);
        await awaitWhileRequestIsLive(this.timer.sleep(SWIPE_SETTLE_MS), signal);
        // The list may still have moved during the settle wait: tap the row where it is now.
        const settled = await awaitWhileRequestIsLive(io.read(undefined, signal), signal);
        const match = pageMatch(this.requireSheet(settled));
        if (!match) {
          throw new ActionableError(
            `Share target ${JSON.stringify(selector)} was no longer visible after the list settled. Reopen the share sheet from the app and retry.`,
          );
        }
        const { x, y } = this.geometry.getElementCenter(match.element);
        await this.sendInput(io, settled, ["tap", String(x), String(y)], signal);
        return match.target;
      }
      const previous =
        back < scan.swipes ? await this.swipeList(io, current, "down", signal) : null;
      if (!previous) {
        throw new ActionableError(
          `Share target ${JSON.stringify(selector)} was no longer visible after scanning the list. Reopen the share sheet from the app and retry.`,
        );
      }
      current = previous;
    }
  }

  /**
   * Scans every page before anything is tapped, so a same-label target further down the
   * list is refused as ambiguous instead of the first page's match being tapped (#14246).
   */
  private async scanForMatch(
    io: AndroidShareSheetDevice,
    initial: AndroidSheetPage,
    {
      pageMatch,
      selector,
    }: { pageMatch: (sheet: AndroidSheet) => AndroidShareRow | undefined; selector?: string },
    signal?: AbortSignal,
  ): Promise<{ last: AndroidSheetPage; swipes: number }> {
    let candidates: AndroidShareRow[] = [];
    let current = initial;
    let previous: { sheet: AndroidSheet; match?: AndroidShareRow } | undefined;
    for (let page = 0; ; page++) {
      const match = pageMatch(current.sheet);
      if (match && !(previous && isSameRowAfterScroll(previous, current.sheet, match))) {
        candidates = withoutSuggestedRepeats([...candidates, match]);
      }
      if (candidates.length > 1) {
        throw ambiguousTarget(selector, candidates, AMBIGUITY_GUIDANCE);
      }
      previous = { sheet: current.sheet, match };
      const next =
        page < CHOOSER_SCAN_PAGES - 1 ? await this.swipeList(io, current, "up", signal) : null;
      if (!next) {
        if (candidates.length === 0) {
          throw new ActionableError(
            `No share target matches ${JSON.stringify(selector)}. Run shareSheet list to see current labels and verified appIds.`,
          );
        }
        return { last: current, swipes: page };
      }
      current = next;
    }
  }

  private async expandSheet(
    io: AndroidShareSheetDevice,
    { hierarchy, sheet }: AndroidSheetPage,
    signal?: AbortSignal,
  ): Promise<AndroidSheetPage | null> {
    if (!sheet.collapsedHandle) {
      return null;
    }
    const fresh = await expandChooserSheet(hierarchy, sheet.collapsedHandle.bounds, {
      signal,
      ...this.chooserGestureIo(io, hierarchy),
    });
    return fresh ? { hierarchy: fresh, sheet: this.requireSheet(fresh) } : null;
  }

  private chooserGestureIo(io: AndroidShareSheetDevice, hierarchy: ViewHierarchyResult) {
    return {
      swipe: (args: string[], signal?: AbortSignal) =>
        io.input(args, hierarchy.displayId ?? undefined, signal),
      read: (minTimestamp: number, signal?: AbortSignal) => io.read(minTimestamp, signal),
      validate: (next: ViewHierarchyResult, minTimestamp: number) => {
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
    };
  }

  private async swipeList(
    io: AndroidShareSheetDevice,
    { hierarchy, sheet }: AndroidSheetPage,
    direction: "up" | "down",
    signal?: AbortSignal,
  ): Promise<AndroidSheetPage | null> {
    const fresh = await swipeChooserList(hierarchy, sheet.list.bounds, {
      direction,
      signal,
      ...this.chooserGestureIo(io, hierarchy),
    });
    return fresh ? { hierarchy: fresh, sheet: this.requireSheet(fresh) } : null;
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
