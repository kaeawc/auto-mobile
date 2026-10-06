import { getAbortSignal } from "../../utils/AbortContext";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  DefaultHostCommandExecutor,
  type HostProcessExecutor,
} from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { outputReportsMissingPackage } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  DeepLinkResult,
  IntentFilter,
  DeepLinkInfo,
  IntentChooserResult,
  ViewHierarchyResult,
  BootedDevice,
  IosInfoPlist,
  ExecResult,
} from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import type { Element } from "../../models/Element";
import { nodeBounds } from "../../models/ViewHierarchyResult";
import type { Timer } from "../../utils/interfaces/Timer";
import { defaultTimer } from "../../utils/SystemTimer";
import { DefaultElementParser } from "./ElementParser";
import { DefaultElementGeometry } from "./ElementGeometry";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import {
  STABLE_VIEW_ID_HASH_LENGTH,
  STABLE_VIEW_ID_PREFIX,
} from "../observe/android/StableNodeIdentity";
import { DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS } from "../action/ClearText";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { PlistClient, type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import {
  AppBundleMetadataClient,
  type AppBundleMetadata,
} from "../../utils/ios-cmdline-tools/AppBundleMetadataClient";

/**
 * Runs a host program (NOT `xcrun simctl`) **by argv, never via a shell**. Used
 * for host commands with literal argv. App-bundle metadata is delegated to
 * dedicated typed clients. Passing an argv array (rather than a command string)
 * means a malicious `.app` path containing shell metacharacters — `$(…)`,
 * backticks, `;`, … — is handed to the program as a single literal argument and
 * can never be expanded into host command execution. The optional `stdin` feeds
 * one program's output into the next without a shell pipe. Modeled on
 * {@link DeviceAppManager}'s injected `exec` so the iOS path is fully fakeable
 * in unit tests.
 */
export type HostExec = (file: string, args: string[], stdin?: string) => Promise<ExecResult>;

const hostProcessExecutor = new DefaultHostCommandExecutor();

export const createDefaultHostExec =
  (
    executor: Pick<HostProcessExecutor, "executeCommandWithChild"> = hostProcessExecutor,
  ): HostExec =>
  (file, args, stdin) =>
    Promise.resolve()
      .then(() => {
        const { child, result } = executor.executeCommandWithChild(file, args, {
          maxBuffer: 16 * 1024 * 1024,
        });
        if (stdin !== undefined) {
          child.stdin?.end(stdin);
        }
        return result;
      })
      .then(undefined, (error: Error) => {
        // The host seam wraps callback and startup errors; HostExec exposes the raw error.
        throw error.cause ?? error;
      });

const defaultHostExec = createDefaultHostExec();

const outputReportsMissingIosApp = (message: string): boolean =>
  message.includes("No such file or directory");

/**
 * Interface for deep link management and intent chooser handling
 * Provides methods to query deep links from apps and handle system intent chooser dialogs
 */
export interface DeepLinkManager {
  /**
   * Set the target device ID
   * @param device - Device identifier
   */
  setDeviceId(device: BootedDevice): void;

  /**
   * Get deep links for an application by querying the package manager
   * @param appId - The application package ID
   * @returns Promise with deep link information
   */
  getDeepLinks(appId: string): Promise<DeepLinkResult>;

  /**
   * Detect system intent chooser dialog in view hierarchy
   * @param viewHierarchy - Current view hierarchy result
   * @returns True if intent chooser is detected
   */
  detectIntentChooser(viewHierarchy: ViewHierarchyResult): boolean;

  /**
   * Handle system intent chooser dialog automatically
   * @param viewHierarchy - Current view hierarchy result
   * @param preference - User preference for handling ("always", "just_once", or "custom")
   * @param customAppPackage - Optional specific app package to select
   * @returns Result of intent chooser handling
   */
  handleIntentChooser(
    viewHierarchy: ViewHierarchyResult,
    preference?: "always" | "just_once" | "custom",
    customAppPackage?: string,
    url?: string,
  ): Promise<IntentChooserResult>;
}

/** Injected chooser label and fresh-hierarchy lookups used by paging and fallback matching. */
export interface ChooserAppMetadata {
  getLabel(device: BootedDevice, packageName: string, signal?: AbortSignal): Promise<string | null>;
  getActivityLabel?(
    device: BootedDevice,
    packageName: string,
    url: string,
    adb: AdbExecutor,
    signal?: AbortSignal,
  ): Promise<ChooserActivityLabelResult>;
  getFreshHierarchy(
    device: BootedDevice,
    adbFactory: AdbClientFactory,
    minTimestamp: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ViewHierarchyResult>;
}

export type ChooserActivityLabelResult =
  | { kind: "literal"; label: string }
  | { kind: "resource" }
  | { kind: "none" };

/** Retry signal for a missing chooser row; carries the capture time when known so paging can continue safely. */
class ChooserRowMissingError extends Error {
  capturedAt?: number;
}

interface ChooserMatch {
  element: Element;
  packageVerified: boolean;
  capturedAt?: number;
  stableId?: string;
  signature: string;
}

// HandleIntentChooser has a 500ms action timeout; leave time for its observation.
const POST_TAP_VERIFY_BUDGET_MS = 200;
const POST_TAP_VERIFY_INTERVAL_MS = 50;
const CHOOSER_SCAN_PAGES = 4;
const CHOOSER_ANCHOR_DELTA_TOLERANCE_PX = 2;
// Bare content-derived IDs denote rows unique within a capture. Ordinal IDs
// and resource-backed IDs can be reassigned when a list scrolls or recycles.
const UNIQUE_CHOOSER_VIEW_ID = new RegExp(
  `^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}}$`,
);

function parseDumpLabel(fields: RegExpExecArray | null): ChooserActivityLabelResult {
  const labelRes = fields?.[1];
  const literal = fields?.[2]?.trim();
  if (literal !== undefined && literal !== "null") {
    return { kind: "literal", label: literal };
  }
  return labelRes && !/^(?:0x0+|0+)$/i.test(labelRes) ? { kind: "resource" } : { kind: "none" };
}

function parseQueryActivity(
  block: string,
): { packageName: string; label: ChooserActivityLabelResult } | null {
  const activityInfo = /^    ActivityInfo:\s*$/m.exec(block);
  if (!activityInfo) {
    return null;
  }
  const resolveInfoFields = block.slice(0, activityInfo.index);
  const resolveInfoLabel = parseDumpLabel(
    /^    labelRes=(\S+)\s+nonLocalizedLabel=(.*?)(?:\s+(?:icon|banner)=|$)/m.exec(
      resolveInfoFields,
    ),
  );
  // ApplicationInfo is nested in ActivityInfo's dump but describes the app,
  // not this intent-resolving activity. Its label must never stand in for one.
  const fields = block
    .slice(activityInfo.index + activityInfo[0].length)
    .split(/^      ApplicationInfo:\s*$/m, 1)[0];
  const name = /^      name=(\S+)\s*$/m.exec(fields)?.[1];
  const packageName = /^      packageName=(\S+)\s*$/m.exec(fields)?.[1];
  if (!name || !packageName) {
    return null;
  }
  const activityLabel = parseDumpLabel(
    /^      labelRes=(\S+)\s+nonLocalizedLabel=(.*?)(?:\s+(?:icon|banner)=|$)/m.exec(fields),
  );
  const label = resolveInfoLabel.kind !== "none" ? resolveInfoLabel : activityLabel;
  return { packageName, label };
}

/** ADB can read literal activity labels, but cannot dereference labelRes. */
export async function resolveChooserActivityLabel(
  adb: AdbExecutor,
  packageName: string,
  url: string,
  signal?: AbortSignal,
): Promise<ChooserActivityLabelResult> {
  // Match OpenURL's VIEW action and data; adding a category would change the
  // query from the intent that `am start -a VIEW -d <url>` actually launched.
  try {
    throwIfAborted(signal);
    const query = await awaitWhileRequestIsLive(
      adb.executeCommand(
        `shell cmd package query-activities -a android.intent.action.VIEW -d ${shellQuote(url)}`,
        undefined,
        undefined,
        undefined,
        signal,
      ),
      signal,
    );
    if (query.stderr.trim()) {
      return { kind: "none" };
    }
    const activities = query.stdout
      .split(/^  Activity #\d+:\s*$/m)
      .slice(1)
      .map(parseQueryActivity)
      .filter((activity) => activity?.packageName === packageName);
    // Several matching activities can carry different labels. Without the
    // resolver's chosen component, claiming one would risk selecting a peer row.
    if (activities.length !== 1) {
      return { kind: "none" };
    }
    return activities[0]?.label ?? { kind: "none" };
  } catch (error) {
    throwIfAborted(signal);
    // This optional ADB enrichment can be absent on older devices; use the
    // existing application-label lookup when the shell query is unavailable.
    logger.debug(`[DeepLinkManager] Activity-label probe unavailable: ${errorMessage(error)}`);
    return { kind: "none" };
  }
}

const defaultChooserAppMetadata: ChooserAppMetadata = {
  async getLabel(device, packageName, signal) {
    const { resolveAppLabel } = await import("../../server/systemTrayHelpers");
    throwIfAborted(signal);
    return resolveAppLabel(device, packageName, signal);
  },
  async getActivityLabel(_device, packageName, url, adb, signal) {
    return resolveChooserActivityLabel(adb, packageName, url, signal);
  },
  async getFreshHierarchy(device, adbFactory, minTimestamp, timeoutMs, signal) {
    return new ViewHierarchy(device, adbFactory).getViewHierarchy(
      undefined,
      undefined,
      true,
      minTimestamp,
      signal,
      timeoutMs,
    );
  },
};

export class DeepLinkManager implements DeepLinkManager {
  private device: BootedDevice | null;
  private adbUtils: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private parser: ElementParser;
  private geometry: ElementGeometry;
  private simctl: Pick<SimCtlClient, "executeCommandArgs">;
  private hostExec: HostExec;
  private plist: PlistReader;
  private appBundleMetadata: AppBundleMetadata;

  private configureAdb(
    device: BootedDevice | null,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null,
  ): { factory: AdbClientFactory; executor: AdbExecutor } {
    // Detect if the argument is a factory (has create method) or an executor.
    if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      const factory = adbFactoryOrExecutor as AdbClientFactory;
      return { factory, executor: factory.create(device) };
    } else if (adbFactoryOrExecutor) {
      // Legacy path: wrap the executor in a factory for downstream dependencies.
      const executor = adbFactoryOrExecutor as AdbExecutor;
      return { factory: { create: () => executor }, executor };
    }
    return { factory: defaultAdbClientFactory, executor: defaultAdbClientFactory.create(device) };
  }

  constructor(
    device: BootedDevice | null = null,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    simctl: Pick<SimCtlClient, "executeCommandArgs"> | null = null,
    hostExec: HostExec | null = null,
    plist: PlistReader = new PlistClient(),
    appBundleMetadata: AppBundleMetadata = new AppBundleMetadataClient(),
    private readonly chooserMetadata?: ChooserAppMetadata,
    private readonly timer: Timer = defaultTimer,
    // HandleIntentChooser creates a manager per execution; never share a request signal across calls.
    private readonly chooserSignal?: AbortSignal,
  ) {
    const adb = this.configureAdb(device, adbFactoryOrExecutor);
    this.adbFactory = adb.factory;
    this.adbUtils = adb.executor;
    this.device = device;
    this.simctl = simctl ?? new SimCtlClient(device);
    this.hostExec = hostExec ?? defaultHostExec;
    this.plist = plist;
    this.appBundleMetadata = appBundleMetadata;
    this.parser = new DefaultElementParser();
    this.geometry = new DefaultElementGeometry();
  }

  /**
   * Set the target device ID
   * @param deviceId - Device identifier
   */
  setDeviceId(device: BootedDevice): void {
    this.device = device;
    this.adbUtils = this.adbFactory.create(device);
  }

  /**
   * Get deep links for an application by querying the package manager
   * @param appId - The application package ID
   * @returns Promise with deep link information
   */
  async getDeepLinks(appId: string): Promise<DeepLinkResult> {
    switch (this.device?.platform) {
      case "ios":
        return this.getDeepLinksIos(appId);
      case "android":
      default:
        return this.getDeepLinksAndroid(appId);
    }
  }

  /**
   * Android deep-link discovery via `dumpsys package`.
   * @param appId - The application package ID
   * @returns Promise with deep link information
   */
  private async getDeepLinksAndroid(appId: string): Promise<DeepLinkResult> {
    try {
      logger.info(`[DeepLinkManager] Querying deep links for app: ${appId}`);

      // Use dumpsys package to get detailed package information including intent filters
      const packageInfoResult = await this.adbUtils.executeCommand(
        `shell dumpsys package ${shellQuote(appId)}`,
      );

      const hasStderr = packageInfoResult.stderr.trim().length > 0;
      const packageMarker = `Package [${appId}]`;
      const hasUsablePackageDump =
        !outputReportsMissingPackage(packageInfoResult.stdout) &&
        packageInfoResult.stdout.split("\n").some((line) => {
          const trimmed = line.trim();
          return trimmed === packageMarker || trimmed.startsWith(`${packageMarker} `);
        });

      if (hasStderr && !hasUsablePackageDump) {
        logger.error(
          `[DeepLinkManager] ADB command failed for ${appId}: ${packageInfoResult.stderr}`,
        );
        return {
          success: false,
          appId,
          deepLinks: {
            schemes: [],
            hosts: [],
            intentFilters: [],
            supportedMimeTypes: [],
          },
          error: packageInfoResult.stderr,
        };
      }

      if (hasStderr) {
        // A matching package header makes the dump usable despite device-image warnings.
        logger.debug(
          `[DeepLinkManager] Benign stderr alongside a complete dumpsys package dump for ${appId}: ${packageInfoResult.stderr}`,
        );
      }

      if (outputReportsMissingPackage(packageInfoResult.stdout)) {
        return {
          success: false,
          appId,
          deepLinks: {
            schemes: [],
            hosts: [],
            intentFilters: [],
            supportedMimeTypes: [],
          },
          error: `Package ${appId} is not installed on the device. Use listApps to see installed packages.`,
        };
      }

      // Parse the results
      const deepLinks = this.parsePackageDumpsysOutput(appId, packageInfoResult.stdout);

      return {
        success: true,
        appId,
        deepLinks,
        rawOutput: packageInfoResult.stdout,
      };
    } catch (error) {
      logger.warn(
        `[DeepLinkManager] Failed to get deep links for ${appId}: ${errorMessage(error)}`,
        error,
      );
      return {
        success: false,
        appId,
        deepLinks: {
          schemes: [],
          hosts: [],
          intentFilters: [],
          supportedMimeTypes: [],
        },
        error: errorMessage(error),
      };
    }
  }

  /**
   * iOS deep-link discovery from static bundle metadata. Custom URL schemes come
   * from the installed `.app`'s `Info.plist` (`CFBundleURLTypes`); universal-link
   * hosts from the code-signing entitlements (`com.apple.developer.associated-domains`).
   *
   * Simulators only — the `.app` bundle is a host filesystem path
   * (`get_app_container ... app`), so host-side metadata clients can read it
   * directly. Physical devices return an explicit "not yet implemented" failure.
   * @param bundleId - The iOS bundle identifier
   * @returns Promise with deep link information
   */
  private async getDeepLinksIos(bundleId: string): Promise<DeepLinkResult> {
    const signal = getAbortSignal();
    try {
      throwIfAborted(signal);
      const udid = this.device!.deviceId;
      logger.info(`[DeepLinkManager] Querying iOS deep links for bundle: ${bundleId}`);

      if (resolveIosDeviceKind({ deviceId: udid }) !== "simulator") {
        return this.emptyIosResult(
          bundleId,
          `Physical-device deep-link discovery for ${bundleId} is not yet implemented`,
        );
      }

      // 1. Resolve the installed .app bundle path (HOST path on the simulator).
      //    A missing app makes simctl exit non-zero ("No such file or directory");
      //    treat that as a clean not-installed result, not a raw thrown error.
      let appPath = "";
      try {
        const container = await this.simctl.executeCommandArgs([
          "get_app_container",
          udid,
          bundleId,
          "app",
        ]);
        throwIfAborted(signal);
        appPath = container.stdout.trim();
      } catch (error) {
        const message = errorMessage(error);
        if (outputReportsMissingIosApp(message)) {
          // Missing apps are an expected lookup outcome; the empty path reports not installed below.
          logger.debug(`[DeepLinkManager] get_app_container missing app ${bundleId}: ${message}`);
          throwIfAborted(signal);
        } else {
          logger.warn(
            `[DeepLinkManager] get_app_container failed for ${bundleId}: ${message}`,
            error,
          );
          throwIfAborted(signal);
          return this.emptyIosResult(bundleId, message);
        }
      }
      if (!appPath) {
        return this.emptyIosResult(bundleId, `App ${bundleId} is not installed on ${udid}`);
      }

      // 2. Info.plist -> JSON via host plutil. argv form (no shell): the
      //    bundle path is a literal argument, so a crafted `.app` name cannot
      //    inject host commands.
      const info = (await this.plist.readJsonFile(`${appPath}/Info.plist`)) as IosInfoPlist;
      throwIfAborted(signal);

      const schemes = this.parseCFBundleURLSchemes(info);
      const associatedDomains = await this.parseAssociatedDomains(appPath, bundleId);
      throwIfAborted(signal);
      const hosts = associatedDomains.hosts;
      const supportedMimeTypes = this.parseDocumentTypes(info);

      return {
        success: true,
        appId: bundleId,
        deepLinks: {
          schemes,
          hosts,
          supportedMimeTypes,
          intentFilters: this.synthesizeIosIntentFilters(schemes, hosts),
        },
        rawOutput: JSON.stringify(info),
        note: associatedDomains.note,
      };
    } catch (error) {
      logger.warn(
        `[DeepLinkManager] Failed to get iOS deep links for ${bundleId}: ${errorMessage(error)}`,
        error,
      );
      throwIfAborted(signal);
      return this.emptyIosResult(bundleId, errorMessage(error));
    }
  }

  private emptyIosResult(appId: string, error: string): DeepLinkResult {
    return {
      success: false,
      appId,
      deepLinks: { schemes: [], hosts: [], intentFilters: [], supportedMimeTypes: [] },
      error,
    };
  }

  private parseCFBundleURLSchemes(info: IosInfoPlist): string[] {
    const out = new Set<string>();
    for (const urlType of info.CFBundleURLTypes ?? []) {
      for (const scheme of urlType.CFBundleURLSchemes ?? []) {
        if (scheme) {
          out.add(scheme);
        }
      }
    }
    return Array.from(out);
  }

  private parseDocumentTypes(info: IosInfoPlist): string[] {
    const out = new Set<string>();
    for (const docType of info.CFBundleDocumentTypes ?? []) {
      for (const contentType of docType.LSItemContentTypes ?? []) {
        if (contentType) {
          out.add(contentType);
        }
      }
    }
    return Array.from(out);
  }

  /**
   * Universal-link hosts from the bundle's typed code-signing entitlements.
   * Unsigned bundles or bundles without associated domains yield `[]`, not an error.
   */
  private async parseAssociatedDomains(
    appPath: string,
    bundleId: string,
  ): Promise<{ hosts: string[]; note?: string }> {
    const entitlements = await this.appBundleMetadata.readEntitlements({
      appBundlePath: appPath,
      deviceId: this.device!.deviceId,
      bundleId,
    });
    if (!entitlements || Object.keys(entitlements).length === 0) {
      // Missing entitlements are expected for unsigned simulator builds.
      return {
        hosts: [],
        note: "The app is unsigned or has no entitlements; no associated domains are available.",
      };
    }
    const domains = entitlements?.["com.apple.developer.associated-domains"];
    if (!Array.isArray(domains)) {
      return { hosts: [] };
    }
    return {
      hosts: domains
        .filter((d): d is string => typeof d === "string" && d.startsWith("applinks:"))
        .map((d) => d.slice("applinks:".length)),
    };
  }

  /**
   * Synthesize cross-platform `IntentFilter` entries from iOS schemes/hosts so the
   * `DeepLinkResult` shape stays populated for platform-agnostic consumers.
   */
  private synthesizeIosIntentFilters(schemes: string[], hosts: string[]): IntentFilter[] {
    const data = [...schemes.map((scheme) => ({ scheme })), ...hosts.map((host) => ({ host }))];
    if (data.length === 0) {
      return [];
    }
    return [
      {
        action: "android.intent.action.VIEW",
        category: [],
        data,
      },
    ];
  }

  /**
   * Parse deep link results from dumpsys package output
   * @param appId - The application package ID
   * @param dumpsysOutput - Output from dumpsys package command
   * @returns Parsed deep link information
   */
  private parsePackageDumpsysOutput(appId: string, dumpsysOutput: string): DeepLinkInfo {
    const schemes = new Set<string>();
    const hosts = new Set<string>();
    const intentFilters: IntentFilter[] = [];
    const supportedMimeTypes = new Set<string>();

    const lines = dumpsysOutput.split("\n");
    let inSchemesSection = false;
    let inIntentFilterSection = false;
    let currentFilter: Partial<IntentFilter> = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Detect start of Schemes section
      if (line === "Schemes:") {
        inSchemesSection = true;
        continue;
      }

      // Process schemes section
      if (inSchemesSection) {
        if (this.isSchemesSectionEnd(line)) {
          inSchemesSection = false;
          continue;
        }

        this.parseSchemeEntry(line, lines, i, schemes, hosts);
      }

      // Process intent filter details
      if (line.includes("Action:") && line.includes("android.intent.action.VIEW")) {
        inIntentFilterSection = true;
        currentFilter = {
          action: "android.intent.action.VIEW",
          category: [],
          data: [],
        };
      }

      if (!inIntentFilterSection) {
        continue;
      }
      this.parseIntentFilterData(line, currentFilter, schemes, hosts, supportedMimeTypes);

      // End of current intent filter
      if (!this.isIntentFilterEnd(line) || !currentFilter.action) {
        continue;
      }
      intentFilters.push(currentFilter as IntentFilter);
      currentFilter = {};
      inIntentFilterSection = false;
    }

    // Add the last filter if we were still processing one
    if (inIntentFilterSection && currentFilter.action) {
      intentFilters.push(currentFilter as IntentFilter);
    }

    return {
      schemes: Array.from(schemes),
      hosts: Array.from(hosts),
      intentFilters,
      supportedMimeTypes: Array.from(supportedMimeTypes),
    };
  }

  private isSchemesSectionEnd(line: string): boolean {
    return (
      line === "" ||
      line.startsWith("Non-Data Actions:") ||
      line.startsWith("Receiver Resolver Table:")
    );
  }

  private parseSchemeEntry(
    line: string,
    lines: string[],
    index: number,
    schemes: Set<string>,
    hosts: Set<string>,
  ): void {
    const schemeMatch = line.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):$/);
    if (!schemeMatch) {
      return;
    }
    schemes.add(schemeMatch[1]);
    this.parseSchemeAuthority(lines, index, hosts);
  }

  private parseSchemeAuthority(lines: string[], index: number, hosts: Set<string>): void {
    // Look ahead for authority information.
    if (index + 1 >= lines.length) {
      return;
    }
    const nextLine = lines[index + 1].trim();
    const authorityMatch = nextLine.match(/^([a-fA-F0-9]+)\s+.*filter\s+([a-fA-F0-9]+)$/);
    if (!authorityMatch) {
      return;
    }
    for (let j = index + 2; j < Math.min(index + 10, lines.length); j++) {
      const authLine = lines[j].trim();
      const hostMatch = authLine.match(/^Authority:\s+"([^"]+)":\s*-?\d+$/);
      if (hostMatch) {
        hosts.add(hostMatch[1]);
        break;
      }
    }
  }

  private isIntentFilterEnd(line: string): boolean {
    return line === "" || (line.includes("filter") && line.includes("Action:"));
  }

  private parseIntentFilterData(
    line: string,
    currentFilter: Partial<IntentFilter>,
    schemes: Set<string>,
    hosts: Set<string>,
    supportedMimeTypes: Set<string>,
  ): void {
    if (line.startsWith("Category:")) {
      const category = line.replace("Category:", "").trim().replace(/"/g, "");
      if (currentFilter.category) {
        currentFilter.category.push(category);
      }
    }

    if (line.startsWith("Scheme:")) {
      const scheme = line.replace("Scheme:", "").trim().replace(/"/g, "");
      schemes.add(scheme);
      if (!currentFilter.data) {
        currentFilter.data = [];
      }
      currentFilter.data.push({ scheme });
    }

    if (line.startsWith("Authority:")) {
      this.parseIntentFilterAuthority(line, currentFilter, hosts);
    }

    if (line.startsWith("Type:")) {
      const mimeType = line.replace("Type:", "").trim().replace(/"/g, "");
      supportedMimeTypes.add(mimeType);
      if (!currentFilter.data) {
        currentFilter.data = [];
      }
      currentFilter.data.push({ mimeType });
    }
  }

  private parseIntentFilterAuthority(
    line: string,
    currentFilter: Partial<IntentFilter>,
    hosts: Set<string>,
  ): void {
    const authorityMatch = line.match(/^Authority:\s+"([^"]+)":\s*-?\d+$/);
    if (!authorityMatch) {
      return;
    }
    const host = authorityMatch[1];
    hosts.add(host);
    if (!currentFilter.data) {
      currentFilter.data = [];
    }
    // Find existing data entry with scheme or create new one.
    const lastDataEntry = currentFilter.data[currentFilter.data.length - 1];
    if (lastDataEntry && !lastDataEntry.host) {
      lastDataEntry.host = host;
      return;
    }
    currentFilter.data.push({ host });
  }

  /**
   * Detect system intent chooser dialog in view hierarchy
   * @param viewHierarchy - Current view hierarchy result
   * @returns True if intent chooser is detected
   */
  detectIntentChooser(viewHierarchy: ViewHierarchyResult): boolean {
    try {
      // If the hierarchy is empty, return false
      if (!viewHierarchy || !viewHierarchy.hierarchy || !viewHierarchy.hierarchy.node) {
        return false;
      }

      // Look for common intent chooser indicators
      const textIndicators = [
        "Choose an app",
        "Open with",
        "Complete action using",
        "Always",
        "Just once",
      ];

      const classIndicators = [
        "com.android.internal.app.ChooserActivity",
        "com.android.internal.app.ResolverActivity",
      ];

      const resourceIdIndicators = [
        "android:id/button_always",
        "android:id/button_once",
        "resolver_list",
        "chooser_list",
      ];

      // Get root nodes from the view hierarchy
      const rootNodes = this.parser.extractRootNodes(viewHierarchy);

      // Check all nodes in the hierarchy
      for (const rootNode of rootNodes) {
        let foundIndicator = false;

        this.parser.traverseNode(rootNode, (node: any) => {
          if (foundIndicator) {
            return;
          }

          const nodeProperties = this.parser.extractNodeProperties(node);
          const nodeClass = nodeProperties.class || "";
          const nodeText = nodeProperties.text || nodeProperties["content-desc"] || "";
          const nodeResourceId = nodeProperties["resource-id"] || "";

          // Check for class indicators
          for (const className of classIndicators) {
            if (nodeClass.includes(className)) {
              foundIndicator = true;
              return;
            }
          }

          // Check for text indicators (exact match)
          for (const text of textIndicators) {
            if (nodeText === text) {
              foundIndicator = true;
              return;
            }
          }

          // Check for resource ID indicators
          for (const resourceId of resourceIdIndicators) {
            if (nodeResourceId.includes(resourceId)) {
              foundIndicator = true;
              return;
            }
          }
        });

        if (foundIndicator) {
          return true;
        }
      }

      return false;
    } catch (error) {
      logger.warn(`[DeepLinkManager] Error detecting intent chooser: ${error}`);
      return false;
    }
  }

  /**
   * Handle system intent chooser dialog automatically
   * @param viewHierarchy - Current view hierarchy result
   * @param preference - User preference for handling ("always", "just_once", or "custom")
   * @param customAppPackage - Optional specific app package to select
   * @returns Result of intent chooser handling
   */
  async handleIntentChooser(
    viewHierarchy: ViewHierarchyResult,
    preference: "always" | "just_once" | "custom" = "just_once",
    customAppPackage?: string,
    url?: string,
  ): Promise<IntentChooserResult> {
    throwIfAborted(this.chooserSignal);
    let chooserMatch: ChooserMatch | undefined;
    try {
      const detected = this.detectIntentChooser(viewHierarchy);

      if (!detected) {
        return {
          success: true,
          detected: false,
        };
      }

      logger.info(`[DeepLinkManager] Intent chooser detected, preference: ${preference}`);

      // Parse the view hierarchy to find buttons
      const rootNodes = this.parser.extractRootNodes(viewHierarchy);
      let targetElement = null;

      if (preference === "always") {
        targetElement = this.findChooserButton(rootNodes, ["Always", "ALWAYS"]);
      } else if (preference === "just_once") {
        targetElement = this.findChooserButton(rootNodes, ["Just once", "JUST ONCE", "Once"]);
      } else if (preference === "custom" && customAppPackage) {
        chooserMatch = await this.findAppInChooserAcrossPages(viewHierarchy, customAppPackage, url);
        targetElement = chooserMatch.element;
      }

      if (!targetElement) {
        return {
          success: false,
          detected: true,
          error: `Could not find target element for preference: ${preference}`,
        };
      }
      return await this.tapChooserElement(
        targetElement,
        preference,
        customAppPackage,
        chooserMatch,
      );
    } catch (error) {
      throwIfAborted(this.chooserSignal);
      logger.warn(
        `[DeepLinkManager] Failed to handle intent chooser: ${errorMessage(error)}`,
        error,
      );
      return {
        success: false,
        detected: true,
        error: errorMessage(error),
        packageVerified: chooserMatch?.packageVerified,
      };
    }
  }

  private findChooserButton(
    rootNodes: ReturnType<ElementParser["extractRootNodes"]>,
    textOptions: string[],
  ): Element | null {
    for (const rootNode of rootNodes) {
      const targetElement = this.findButtonByText(rootNode, textOptions);
      if (targetElement) {
        return targetElement;
      }
    }
    return null;
  }

  private async tapChooserElement(
    targetElement: Element,
    preference: "always" | "just_once" | "custom",
    customAppPackage: string | undefined,
    chooserMatch: ChooserMatch | undefined,
  ): Promise<IntentChooserResult> {
    // Simulate tap on the target element
    const center = this.geometry.getElementCenter(targetElement);
    throwIfAborted(this.chooserSignal);
    const tapResult = await awaitWhileRequestIsLive(
      this.adbUtils.executeCommand(
        `shell input tap ${center.x} ${center.y}`,
        undefined,
        undefined,
        undefined,
        this.chooserSignal,
      ),
      this.chooserSignal,
    );

    // Check if tap command failed
    if (tapResult.stderr && tapResult.stderr.trim().length > 0) {
      logger.error(`[DeepLinkManager] Failed to tap on intent chooser option: ${tapResult.stderr}`);
      return {
        success: false,
        detected: true,
        error: tapResult.stderr,
        packageVerified: chooserMatch?.packageVerified,
      };
    }

    logger.info(`[DeepLinkManager] Tapped on intent chooser option at (${center.x}, ${center.y})`);

    const tapTimestamp =
      chooserMatch && !chooserMatch.packageVerified
        ? await this.getChooserTapFreshnessFloor()
        : undefined;
    // Callers compare against the device's raw capture timestamp; the
    // next-second margin belongs only to this method's polling floor.
    const tappedAt = tapTimestamp?.timestampMs;
    if (chooserMatch && !chooserMatch.packageVerified) {
      const verified =
        tapTimestamp !== undefined &&
        (await this.verifyPostTapChooserPackage(
          customAppPackage!,
          tapTimestamp.floor,
          tapTimestamp.deviceSeconds,
        ));
      if (!verified) {
        return {
          success: false,
          detected: true,
          error: `Unverified chooser selection for ${customAppPackage}: a fresh post-tap hierarchy did not confirm the foreground package.`,
          tappedAt,
          packageVerified: false,
        };
      }
    }
    return {
      success: true,
      detected: true,
      action: preference,
      appSelected: customAppPackage,
      tappedAt,
      packageVerified: chooserMatch?.packageVerified,
    };
  }

  private async getChooserTapFreshnessFloor(): Promise<
    { timestampMs: number; floor: number; deviceSeconds: boolean } | undefined
  > {
    throwIfAborted(this.chooserSignal);
    const timestampResult = await awaitWhileRequestIsLive(
      this.adbUtils.getDeviceTimestampMsWithSource(undefined, this.chooserSignal),
      this.chooserSignal,
    );
    if (timestampResult.source === "host") {
      return undefined;
    }
    const deviceSeconds = timestampResult.source === "device-seconds";
    return {
      timestampMs: timestampResult.timestampMs,
      floor:
        timestampResult.timestampMs +
        (deviceSeconds ? DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS : 0),
      deviceSeconds,
    };
  }

  private async verifyPostTapChooserPackage(
    appPackage: string,
    tappedAt: number,
    deviceSeconds: boolean,
  ): Promise<boolean> {
    const metadata = this.chooserMetadata ?? defaultChooserAppMetadata;
    const deadline = this.timer.now() + POST_TAP_VERIFY_BUDGET_MS;
    let floor = tappedAt;
    let latestObservedAt = -Infinity;
    for (;;) {
      const readBudget = deadline - this.timer.now();
      if (readBudget <= 0) {
        return false;
      }
      let observed: ViewHierarchyResult;
      try {
        throwIfAborted(this.chooserSignal);
        observed = await awaitWhileRequestIsLive(
          metadata.getFreshHierarchy(
            this.device!,
            this.adbFactory,
            floor,
            readBudget,
            this.chooserSignal,
          ),
          this.chooserSignal,
        );
      } catch (error) {
        throwIfAborted(this.chooserSignal);
        logger.warn(`[DeepLinkManager] Post-tap chooser hierarchy read failed: ${error}`);
        return false;
      }
      if (
        this.isConfirmedPostTapPackage(
          observed,
          appPackage,
          tappedAt,
          deviceSeconds,
          latestObservedAt,
          floor,
        )
      ) {
        return true;
      }
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        return false;
      }
      latestObservedAt = Math.max(latestObservedAt, observed.updatedAt ?? -Infinity);
      floor = deviceSeconds
        ? Math.max(floor, (observed.updatedAt ?? floor - 1) + 1)
        : Math.max(floor, observed.updatedAt ?? floor) + 1;
      await awaitWhileRequestIsLive(
        this.timer.sleep(Math.min(POST_TAP_VERIFY_INTERVAL_MS, remaining)),
        this.chooserSignal,
      );
    }
  }

  private isConfirmedPostTapPackage(
    observed: ViewHierarchyResult,
    appPackage: string,
    tappedAt: number,
    deviceSeconds: boolean,
    latestObservedAt: number,
    floor: number,
  ): boolean {
    return (
      observed.updatedAt !== undefined &&
      (deviceSeconds
        ? observed.updatedAt >= latestObservedAt &&
          observed.updatedAt >= tappedAt - DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS
        : observed.updatedAt >= floor) &&
      observed.packageName === appPackage &&
      !this.hasResolverHostEvidence(observed)
    );
  }

  private hasResolverHostEvidence(observed: ViewHierarchyResult): boolean {
    const host = /(?:^|\/)(?:com\.android\.intentresolver|com\.android\.systemui)(?:\/|$)/;
    if (host.test(observed.packageName ?? "") || host.test(observed.foregroundActivity ?? "")) {
      return true;
    }
    const activity = observed.foregroundActivity ?? "";
    if (/com\.android\.internal\.app\.(?:Chooser|Resolver)Activity/.test(activity)) {
      return true;
    }
    for (const root of this.parser.extractRootNodes(observed)) {
      let found = false;
      this.parser.traverseNode(root, (node: any) => {
        const nodeClass = this.parser.extractNodeProperties(node).class;
        if (
          typeof nodeClass === "string" &&
          /com\.android\.internal\.app\.(?:Chooser|Resolver)Activity/.test(nodeClass)
        ) {
          found = true;
        }
      });
      if (found) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find a button by text content in the view hierarchy
   * @param node - Root node to search from
   * @param textOptions - Array of text options to match
   * @returns Found element or null
   */
  private findButtonByText(node: any, textOptions: string[]): any {
    let foundElement: any = null;

    this.parser.traverseNode(node, (currentNode: any) => {
      if (foundElement) {
        return;
      } // Already found

      const properties = this.parser.extractNodeProperties(currentNode);
      const text = properties.text || properties["content-desc"] || "";
      const className = properties.class || "";

      // Check if this is a button-like element with matching text
      if (
        (className.includes("Button") || className.includes("TextView")) &&
        textOptions.some((option) => text.toLowerCase().includes(option.toLowerCase()))
      ) {
        foundElement = currentNode;
      }
    });

    return foundElement;
  }

  /**
   * Find a specific app in the intent chooser list
   * @param nodes - All chooser roots to search for distinct clickable rows
   * @param appPackage - App package to find
   * @returns The unique matching clickable row; throws when missing or ambiguous
   */
  private async findAppInChooser(
    nodes: any[],
    appPackage: string,
    hierarchyPackage?: string,
    resolvedLabel?: string | null,
    originalUpdatedAt?: number,
    url?: string,
  ): Promise<ChooserMatch> {
    const packageRows = new Set<any>();
    const labelRows = new Map<any, Set<string>>();
    const rowsWithPackageMetadata = new Set<any>();
    for (const node of nodes) {
      const rootProperties = this.parser.extractNodeProperties(node);
      const hostPackage = hierarchyPackage ?? rootProperties.package ?? rootProperties.packageName;
      const ancestors: any[] = [];
      this.parser.traverseNode(node, (currentNode: any, depth: number) => {
        ancestors.length = depth;
        ancestors[depth] = currentNode;
        const properties = this.parser.extractNodeProperties(currentNode);
        const row = ancestors.toReversed().find((ancestor) => {
          const clickable = this.parser.extractNodeProperties(ancestor).clickable;
          return clickable === true || clickable === "true";
        });
        if (!row) {
          return;
        }
        const resourceId = properties["resource-id"] ?? "";
        const separator = resourceId.indexOf(":id/");
        const namespace = separator > 0 ? resourceId.slice(0, separator) : undefined;
        const inAppList = ancestors.some((ancestor) => {
          const id = this.parser.extractNodeProperties(ancestor)["resource-id"];
          return typeof id === "string" && /(?:^|\/)(?:resolver_list|chooser_list|list)$/.test(id);
        });
        // Framework-owned chooser widgets are not metadata for the represented app.
        const packages = [properties.package, properties.packageName, namespace].filter(
          (value): value is string =>
            typeof value === "string" &&
            value.length > 0 &&
            value !== hostPackage &&
            value !== "android" &&
            value !== "com.android.intentresolver" &&
            value !== "com.android.systemui",
        );
        if (packages.length > 0) {
          rowsWithPackageMetadata.add(row);
        }
        if (inAppList && packages.includes(appPackage)) {
          packageRows.add(row);
        }
        const labels = labelRows.get(row) ?? new Set<string>();
        for (const value of [properties.text, properties["content-desc"]]) {
          if (typeof value === "string" && value.length > 0) {
            labels.add(value);
          }
        }
        if (inAppList) {
          labelRows.set(row, labels);
        }
      });
    }
    const candidates = [...packageRows];
    if (candidates.length === 0 && this.device) {
      return this.findChooserLabelFallback(
        appPackage,
        labelRows,
        rowsWithPackageMetadata,
        resolvedLabel,
        originalUpdatedAt,
        url,
      );
    }
    return this.selectUniqueChooserRow(candidates, labelRows, appPackage, true);
  }

  /** Scans at most four chooser pages, retrying missing rows after a swipe and propagating terminal errors. */
  private async findAppInChooserAcrossPages(
    initialHierarchy: ViewHierarchyResult,
    appPackage: string,
    url?: string,
  ): Promise<ChooserMatch> {
    const metadata = this.chooserMetadata ?? defaultChooserAppMetadata;
    let hierarchy = initialHierarchy;
    const matches = new Map<string, ChooserMatch>();
    let missing: ChooserRowMissingError | undefined;
    let matchingPage = -1;
    let currentPage = 0;
    let previousMatch: { page: number; key: string; match: ChooserMatch } | undefined;
    let observedDisplacement: number | undefined;
    for (let page = 0; page < CHOOSER_SCAN_PAGES; page += 1) {
      currentPage = page;
      const roots = this.parser.extractRootNodes(hierarchy);
      try {
        const match = await this.findAppInChooser(
          roots,
          appPackage,
          hierarchy.packageName,
          undefined,
          hierarchy.updatedAt,
          url,
        );
        previousMatch = this.recordChooserMatch(
          matches,
          previousMatch,
          match,
          page,
          observedDisplacement,
        );
        matchingPage = page;
      } catch (error) {
        throwIfAborted(this.chooserSignal);
        if (!(error instanceof ChooserRowMissingError)) {
          throw error;
        }
        logger.debug(
          `[DeepLinkManager] No matching row on chooser page ${page + 1}: ${error.message}`,
        );
        missing = error;
        previousMatch = undefined;
      }
      if (page === CHOOSER_SCAN_PAGES - 1) {
        break;
      }
      const next = await this.scrollChooserList(
        hierarchy,
        roots,
        metadata,
        appPackage,
        Math.max(
          missing?.capturedAt ?? 0,
          ...[...matches.values()].map((match) => match.capturedAt ?? 0),
        ),
      );
      if (!next) {
        break;
      }
      observedDisplacement = this.getObservedChooserDisplacement(
        hierarchy,
        next.hierarchy,
        previousMatch?.match.stableId,
      );
      hierarchy = next.hierarchy;
    }
    const unique = this.selectUniqueAcrossPages(matches, missing, appPackage);
    if (matchingPage === currentPage) {
      return unique;
    }
    return this.restoreChooserPage(hierarchy, appPackage, unique, metadata, url);
  }

  private recordChooserMatch(
    matches: Map<string, ChooserMatch>,
    previous: { page: number; key: string; match: ChooserMatch } | undefined,
    match: ChooserMatch,
    page: number,
    observedDisplacement?: number,
  ): { page: number; key: string; match: ChooserMatch } {
    const sameRow =
      previous?.page === page - 1 &&
      observedDisplacement !== undefined &&
      this.isChooserRowSlidingAcrossSwipe(previous.match, match, observedDisplacement);
    const key = sameRow && previous ? previous.key : `page:${page}`;
    matches.set(key, match);
    return { page, key, match };
  }

  private isChooserRowSlidingAcrossSwipe(
    previous: ChooserMatch,
    current: ChooserMatch,
    observedDisplacement: number,
  ): boolean {
    if (
      !previous.stableId ||
      previous.stableId !== current.stableId ||
      previous.signature !== current.signature
    ) {
      return false;
    }
    const before = previous.element.bounds;
    const after = current.element.bounds;
    return (
      Math.abs(after.top - before.top - observedDisplacement) <= 1 &&
      Math.abs(after.bottom - before.bottom - observedDisplacement) <= 1
    );
  }

  private getObservedChooserDisplacement(
    before: ViewHierarchyResult,
    after: ViewHierarchyResult,
    targetStableId?: string,
  ): number | undefined {
    const earlier = this.getChooserAnchorRows(before);
    const later = this.getChooserAnchorRows(after);
    const deltas: number[] = [];
    for (const [id, row] of earlier) {
      const next = later.get(id);
      if (
        id !== targetStableId &&
        next?.signature === row.signature &&
        // The only caller scans forward with an upward swipe, moving list rows upward.
        next.top - row.top < 0 &&
        Math.abs(next.bottom - row.bottom - (next.top - row.top)) <= 1
      ) {
        deltas.push(next.top - row.top);
      }
    }
    if (deltas.length === 0) {
      return undefined;
    }
    deltas.sort((a, b) => a - b);
    if (deltas[deltas.length - 1] - deltas[0] > CHOOSER_ANCHOR_DELTA_TOLERANCE_PX) {
      return undefined;
    }
    const middle = Math.floor(deltas.length / 2);
    return deltas.length % 2 === 1 ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2;
  }

  private getChooserAnchorRows(
    hierarchy: ViewHierarchyResult,
  ): Map<string, { top: number; bottom: number; signature: string }> {
    const rows = new Map<string, { top: number; bottom: number; signature: string }>();
    const duplicateIds = new Set<string>();
    for (const root of this.parser.extractRootNodes(hierarchy)) {
      const ancestors: any[] = [];
      this.parser.traverseNode(root, (node: any, depth: number) => {
        ancestors.length = depth;
        ancestors[depth] = node;
        const properties = this.parser.extractNodeProperties(node);
        const id = properties["view-id"];
        const listIndex = ancestors.findIndex((ancestor) => {
          const resourceId = this.parser.extractNodeProperties(ancestor)["resource-id"];
          return (
            typeof resourceId === "string" &&
            /(?:^|\/)(?:resolver_list|chooser_list|list)$/.test(resourceId)
          );
        });
        const outermostClickable = ancestors.slice(listIndex + 1).find((ancestor) => {
          const clickable = this.parser.extractNodeProperties(ancestor).clickable;
          return clickable === true || clickable === "true";
        });
        if (
          listIndex < 0 ||
          outermostClickable !== node ||
          typeof id !== "string" ||
          !UNIQUE_CHOOSER_VIEW_ID.test(id)
        ) {
          return;
        }
        const bounds = this.parser.parseNodeBounds(node)?.bounds;
        if (!bounds || duplicateIds.has(id)) {
          return;
        }
        const contents: string[] = [];
        this.parser.traverseNode(node, (child: any) => {
          const parts = this.parser.extractNodeProperties(child);
          contents.push(
            JSON.stringify([
              parts.text,
              parts["content-desc"],
              parts.package,
              parts.packageName,
              parts["resource-id"],
              parts.class,
            ]),
          );
        });
        if (rows.has(id)) {
          rows.delete(id);
          duplicateIds.add(id);
        } else {
          rows.set(id, { top: bounds.top, bottom: bounds.bottom, signature: contents.join("|") });
        }
      });
    }
    return rows;
  }

  private selectUniqueAcrossPages(
    matches: Map<string, ChooserMatch>,
    missing: ChooserRowMissingError | undefined,
    appPackage: string,
  ): ChooserMatch {
    if (matches.size > 1) {
      throw new Error(
        `Ambiguous chooser rows for ${appPackage} across pages. Use a chooser with one exact app match.`,
      );
    }
    if (matches.size === 0) {
      throw (
        missing ?? new ChooserRowMissingError(`No exact clickable chooser row for ${appPackage}.`)
      );
    }
    return [...matches.values()][0];
  }

  private async findMatchingChooserRow(
    hierarchy: ViewHierarchyResult,
    appPackage: string,
    expected: ChooserMatch,
    url?: string,
  ): Promise<{ match?: ChooserMatch; capturedAt?: number }> {
    try {
      const match = await this.findAppInChooser(
        this.parser.extractRootNodes(hierarchy),
        appPackage,
        hierarchy.packageName,
        undefined,
        hierarchy.updatedAt,
        url,
      );
      if (
        expected.stableId
          ? match.stableId === expected.stableId && match.signature === expected.signature
          : match.signature === expected.signature
      ) {
        return { match };
      }
      return { capturedAt: match.capturedAt };
    } catch (error) {
      throwIfAborted(this.chooserSignal);
      if (!(error instanceof ChooserRowMissingError)) {
        throw error;
      }
      // A missing row is expected on intermediate viewports; keep scrolling.
      logger.debug(`[DeepLinkManager] Row not yet restored for ${appPackage}: ${error.message}`);
      return { capturedAt: error.capturedAt };
    }
  }

  private async restoreChooserPage(
    hierarchy: ViewHierarchyResult,
    appPackage: string,
    expected: ChooserMatch,
    metadata: ChooserAppMetadata,
    url?: string,
  ): Promise<ChooserMatch> {
    let capturedAt = expected.capturedAt;
    for (let page = 0; page < CHOOSER_SCAN_PAGES; page += 1) {
      const previous = await this.scrollChooserList(
        hierarchy,
        this.parser.extractRootNodes(hierarchy),
        metadata,
        appPackage,
        capturedAt,
        "down",
      );
      if (!previous) {
        break;
      }
      hierarchy = previous.hierarchy;
      const result = await this.findMatchingChooserRow(hierarchy, appPackage, expected, url);
      if (result.match) {
        return result.match;
      }
      capturedAt = result.capturedAt;
    }
    throw new Error(
      `Could not restore the unique chooser row for ${appPackage} after checking all pages.`,
    );
  }

  /** Swipes and refreshes the chooser hierarchy; returns null when no useful scroll is possible and throws on refresh failure. */
  private async scrollChooserList(
    hierarchy: ViewHierarchyResult,
    roots: any[],
    metadata: ChooserAppMetadata,
    appPackage: string,
    capturedAt?: number,
    direction: "up" | "down" = "up",
  ): Promise<{ hierarchy: ViewHierarchyResult } | null> {
    const list = this.findChooserList(roots);
    if (!list || list.bounds.bottom - list.bounds.top < 40) {
      return null;
    }
    const centerX = Math.round((list.bounds.left + list.bounds.right) / 2);
    const height = list.bounds.bottom - list.bounds.top;
    const lowerY = Math.round(list.bounds.bottom - height / 4);
    const upperY = Math.round(list.bounds.top + height / 4);
    const [fromY, toY] = direction === "up" ? [lowerY, upperY] : [upperY, lowerY];
    throwIfAborted(this.chooserSignal);
    const swipe = await awaitWhileRequestIsLive(
      this.adbUtils.executeCommand(
        `shell input swipe ${centerX} ${fromY} ${centerX} ${toY} 350`,
        undefined,
        undefined,
        undefined,
        this.chooserSignal,
      ),
      this.chooserSignal,
    );
    if (swipe.stderr?.trim()) {
      throw new Error(`Could not scroll chooser app list: ${swipe.stderr.trim()}`);
    }
    const nextTimestamp = Math.max(hierarchy.updatedAt ?? 0, capturedAt ?? 0) + 1;
    throwIfAborted(this.chooserSignal);
    const fresh = await awaitWhileRequestIsLive(
      metadata.getFreshHierarchy(
        this.device!,
        this.adbFactory,
        nextTimestamp,
        undefined,
        this.chooserSignal,
      ),
      this.chooserSignal,
    );
    this.validateScrolledChooser(fresh, nextTimestamp, appPackage);
    return JSON.stringify(fresh.hierarchy) === JSON.stringify(hierarchy.hierarchy)
      ? null
      : { hierarchy: fresh };
  }

  private validateScrolledChooser(
    fresh: ViewHierarchyResult,
    minTimestamp: number,
    appPackage: string,
  ): void {
    if (fresh.updatedAt === undefined || fresh.updatedAt < minTimestamp) {
      throw new Error(`Chooser hierarchy did not refresh after scrolling for ${appPackage}.`);
    }
    if (!this.detectIntentChooser(fresh)) {
      throw new Error(`Intent chooser disappeared while finding ${appPackage}.`);
    }
  }

  private findChooserList(roots: any[]): Element | undefined {
    const lists: Element[] = [];
    for (const root of roots) {
      this.parser.traverseNode(root, (node: any) => {
        const id = this.parser.extractNodeProperties(node)["resource-id"];
        if (typeof id === "string" && /(?:^|\/)(?:resolver_list|chooser_list|list)$/.test(id)) {
          const parsed = this.parser.parseNodeBounds(node);
          if (parsed) {
            lists.push(parsed);
          }
        }
      });
    }
    return lists.at(-1);
  }

  /** Matches by resolved labels when package metadata yields no row; unsafe or stale refreshes throw. */
  private async findChooserLabelFallback(
    appPackage: string,
    labelRows: Map<any, Set<string>>,
    rowsWithPackageMetadata: Set<any>,
    resolvedLabel: string | null | undefined,
    originalUpdatedAt?: number,
    url?: string,
  ): Promise<ChooserMatch> {
    if (resolvedLabel === undefined) {
      if (originalUpdatedAt === undefined) {
        throw new Error(
          `Cannot safely refresh chooser for ${appPackage} without a capture timestamp.`,
        );
      }
      const metadata = this.chooserMetadata ?? defaultChooserAppMetadata;
      const labels = await this.resolveChooserLabels(metadata, appPackage, url);
      throwIfAborted(this.chooserSignal);
      const freshHierarchy = await awaitWhileRequestIsLive(
        metadata.getFreshHierarchy(
          this.device!,
          this.adbFactory,
          originalUpdatedAt + 1,
          undefined,
          this.chooserSignal,
        ),
        this.chooserSignal,
      );
      if (freshHierarchy.updatedAt === undefined || freshHierarchy.updatedAt <= originalUpdatedAt) {
        throw new Error(`Chooser hierarchy did not refresh after resolving ${appPackage}.`);
      }
      if (!this.detectIntentChooser(freshHierarchy)) {
        throw new Error(`Intent chooser disappeared while resolving ${appPackage}.`);
      }
      try {
        const match = await this.findChooserLabelCandidates(freshHierarchy, appPackage, labels);
        return { ...match, capturedAt: freshHierarchy.updatedAt };
      } catch (error) {
        throwIfAborted(this.chooserSignal);
        if (error instanceof ChooserRowMissingError) {
          error.capturedAt = freshHierarchy.updatedAt;
        }
        throw error;
      }
    }
    const candidates = resolvedLabel
      ? [...labelRows]
          .filter(([row, labels]) => !rowsWithPackageMetadata.has(row) && labels.has(resolvedLabel))
          .map(([row]) => row)
      : [];
    return this.selectUniqueChooserRow(candidates, labelRows, appPackage, false);
  }

  private async findChooserLabelCandidates(
    hierarchy: ViewHierarchyResult,
    appPackage: string,
    labels: string[],
  ): Promise<ChooserMatch> {
    const roots = this.parser.extractRootNodes(hierarchy);
    let missing: ChooserRowMissingError | undefined;
    for (const label of labels) {
      try {
        return await this.findAppInChooser(roots, appPackage, hierarchy.packageName, label);
      } catch (error) {
        throwIfAborted(this.chooserSignal);
        if (!(error instanceof ChooserRowMissingError)) {
          throw error;
        }
        missing = error;
      }
    }
    if (missing) {
      throw missing;
    }
    return this.selectUniqueChooserRow([], new Map(), appPackage, false);
  }

  private async resolveChooserLabels(
    metadata: ChooserAppMetadata,
    appPackage: string,
    url?: string,
  ): Promise<string[]> {
    let activity: ChooserActivityLabelResult = { kind: "none" };
    if (url && metadata.getActivityLabel) {
      try {
        throwIfAborted(this.chooserSignal);
        activity = await awaitWhileRequestIsLive(
          metadata.getActivityLabel(
            this.device!,
            appPackage,
            url,
            this.adbUtils,
            this.chooserSignal,
          ),
          this.chooserSignal,
        );
      } catch (error) {
        throwIfAborted(this.chooserSignal);
        // Optional activity metadata may be unavailable; the application label
        // remains the established best-effort chooser fallback.
        logger.debug(`[DeepLinkManager] Activity label unavailable: ${errorMessage(error)}`);
      }
    }
    if (activity.kind === "resource") {
      return [];
    }
    throwIfAborted(this.chooserSignal);
    const application = await awaitWhileRequestIsLive(
      metadata.getLabel(this.device!, appPackage, this.chooserSignal),
      this.chooserSignal,
    );
    const labels = activity.kind === "literal" ? [activity.label] : [];
    if (application) {
      labels.push(application);
    }
    return labels;
  }

  /** Returns the sole candidate with usable bounds; missing and ambiguous matches throw. */
  private selectUniqueChooserRow(
    candidates: any[],
    labelRows: Map<any, Set<string>>,
    appPackage: string,
    packageVerified: boolean,
  ): ChooserMatch {
    if (candidates.length > 1) {
      const descriptions = candidates.map((row, index) => {
        return `${index + 1}: ${[...(labelRows.get(row) ?? [])].join(" / ")} bounds=${JSON.stringify(nodeBounds(row))}`;
      });
      throw new Error(
        `Ambiguous chooser rows for ${appPackage}: ${descriptions.join("; ")}. Use a chooser with one exact app match.`,
      );
    }
    if (candidates.length === 0) {
      throw new ChooserRowMissingError(
        `No exact clickable chooser row for ${appPackage}. Verify the app is installed and handles this link.`,
      );
    }
    const target = this.parser.parseNodeBounds(candidates[0]);
    if (!target) {
      throw new Error(
        `Exact chooser row for ${appPackage} has no usable bounds. Refresh the hierarchy before retrying.`,
      );
    }
    const properties = this.parser.extractNodeProperties(candidates[0]);
    // The producer reserves a bare content-derived view-id for a row unique
    // within its capture. Resource-backed and ordinal IDs cannot prove that.
    const stableId =
      typeof properties["view-id"] === "string" &&
      UNIQUE_CHOOSER_VIEW_ID.test(properties["view-id"])
        ? properties["view-id"]
        : undefined;
    const signature = JSON.stringify([
      appPackage,
      packageVerified,
      [...(labelRows.get(candidates[0]) ?? [])].sort(),
    ]);
    return { element: target, packageVerified, stableId, signature };
  }
}
