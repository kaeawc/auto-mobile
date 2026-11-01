import {
  BootedDevice,
  DeepLinkInfo,
  DeepLinkResult,
  ExecResult,
  IntentChooserResult,
  IntentFilter,
  IosInfoPlist,
  ViewHierarchyResult,
} from "../../models";
import { getAbortSignal } from "../../utils/AbortContext";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { outputReportsMissingPackage } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  DefaultHostCommandExecutor,
  type HostProcessExecutor,
} from "../../utils/HostCommandExecutor";
import {
  AppBundleMetadataClient,
  type AppBundleMetadata,
} from "../../utils/ios-cmdline-tools/AppBundleMetadataClient";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { PlistClient, type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { throwIfAborted } from "../../utils/toolUtils";
import type { DeepLinkManagerDependencies } from "./DeepLinkManagerDependencies";
import { IntentChooserHandler } from "./IntentChooserHandler";
export { resolveChooserActivityLabel } from "./chooserAppMetadata";
export type { ChooserActivityLabelResult, ChooserAppMetadata } from "./chooserAppMetadata";

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

/** Copies a physical device's installed bundle to the host (`DeviceAppManager`). */
export type PhysicalIosBundleSource = Pick<
  DeviceAppManager,
  "getInstalledAppInfo" | "withInstalledAppBundle"
>;

/** Process-wide: DeepLinkManager is built per request, and a bundle copy is the slow part. */
const PHYSICAL_DEEP_LINK_CACHE = new Map<string, DeepLinkResult>();
const PHYSICAL_DEEP_LINK_CACHE_LIMIT = 64;

/**
 * Cache key from the device, bundle id and the installed version devicectl reports. Without a
 * version a reinstall could not be told apart, so nothing is cached.
 */
export function physicalDeepLinkCacheKey(
  udid: string,
  bundleId: string,
  installed: Record<string, unknown> | null,
): string | undefined {
  const version = [installed?.version, installed?.bundleVersion].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return version.length > 0 ? JSON.stringify([udid, bundleId, ...version]) : undefined;
}

export class DeepLinkManager implements DeepLinkManager {
  private device: BootedDevice | null;
  private adbUtils: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private simctl: Pick<SimCtlClient, "executeCommandArgs">;
  private hostExec: HostExec;
  private plist: PlistReader;
  private appBundleMetadata: AppBundleMetadata;
  private deviceApps: PhysicalIosBundleSource;
  private physicalCache: Map<string, DeepLinkResult>;

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
    dependencies: DeepLinkManagerDependencies = {},
  ) {
    const adb = this.configureAdb(device, adbFactoryOrExecutor);
    this.adbFactory = adb.factory;
    this.adbUtils = adb.executor;
    this.device = device;
    this.simctl = dependencies.simctl ?? new SimCtlClient(device);
    this.hostExec = dependencies.hostExec ?? defaultHostExec;
    this.plist = dependencies.plist ?? new PlistClient();
    this.appBundleMetadata = dependencies.appBundleMetadata ?? new AppBundleMetadataClient();
    this.deviceApps = dependencies.deviceApps ?? new DeviceAppManager();
    this.physicalCache = dependencies.physicalDeepLinkCache ?? PHYSICAL_DEEP_LINK_CACHE;
    this.chooser = new IntentChooserHandler(device, {
      adbFactory: this.adbFactory,
      dependencies,
      detectChooser: (hierarchy) => this.detectIntentChooser(hierarchy),
      executor: this.adbUtils,
    });
  }

  /**
   * Set the target device ID
   * @param deviceId - Device identifier
   */
  setDeviceId(device: BootedDevice): void {
    this.device = device;
    this.adbUtils = this.adbFactory.create(device);
    this.chooser.setDeviceId(device, this.adbUtils);
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
        { maxBuffer: DUMPSYS_MAX_BUFFER },
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
        return await this.getDeepLinksIosPhysical(udid, bundleId, signal);
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
          logger.debug(
            `[DeepLinkManager] app container lookup missing app ${bundleId}: ${message}`,
          );
          throwIfAborted(signal);
        } else {
          logger.warn(
            `[DeepLinkManager] app container lookup failed for ${bundleId}: ${message}`,
            error,
          );
          throwIfAborted(signal);
          return this.emptyIosResult(bundleId, message);
        }
      }
      if (!appPath) {
        return this.emptyIosResult(bundleId, `App ${bundleId} is not installed on ${udid}`);
      }

      return await this.readIosBundleDeepLinks(appPath, bundleId, signal);
    } catch (error) {
      logger.warn(
        `[DeepLinkManager] Failed to get iOS deep links for ${bundleId}: ${errorMessage(error)}`,
        error,
      );
      throwIfAborted(signal);
      return this.emptyIosResult(bundleId, errorMessage(error));
    }
  }

  /**
   * Physical iOS (#14094): copy the installed bundle off the device with devicectl and read it
   * exactly as the Simulator path reads its host bundle. A successful read is cached per device,
   * bundle id and installed version so repeat calls skip the copy.
   */
  private async getDeepLinksIosPhysical(
    udid: string,
    bundleId: string,
    signal?: AbortSignal,
  ): Promise<DeepLinkResult> {
    const installed = await this.deviceApps.getInstalledAppInfo(udid, bundleId);
    throwIfAborted(signal);
    const cacheKey = physicalDeepLinkCacheKey(udid, bundleId, installed);
    const cached = cacheKey ? this.physicalCache.get(cacheKey) : undefined;
    if (cached) {
      return cached;
    }
    const result = await this.deviceApps.withInstalledAppBundle(
      udid,
      bundleId,
      (appPath) => this.readIosBundleDeepLinks(appPath, bundleId, signal),
      { surfaceLookupErrors: true },
    );
    throwIfAborted(signal);
    if (!result) {
      return this.emptyIosResult(bundleId, `App ${bundleId} is not installed on ${udid}`);
    }
    if (cacheKey && result.success) {
      if (this.physicalCache.size >= PHYSICAL_DEEP_LINK_CACHE_LIMIT) {
        this.physicalCache.delete(this.physicalCache.keys().next().value as string);
      }
      this.physicalCache.set(cacheKey, result);
    }
    return result;
  }

  /** Deep links from an on-disk `.app`: Info.plist schemes, document types, entitlement hosts. */
  private async readIosBundleDeepLinks(
    appPath: string,
    bundleId: string,
    signal?: AbortSignal,
  ): Promise<DeepLinkResult> {
    // Info.plist -> JSON via host plutil. argv form (no shell): the bundle path
    // is a literal argument, so a crafted `.app` name cannot inject host commands.
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

        this.parseSchemeEntry(line, lines, i, { schemes, hosts });
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
      this.parseIntentFilterData(line, currentFilter, schemes, { hosts, supportedMimeTypes });

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
    { schemes, hosts }: { schemes: Set<string>; hosts: Set<string> },
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
    { hosts, supportedMimeTypes }: { hosts: Set<string>; supportedMimeTypes: Set<string> },
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
  private readonly chooser: IntentChooserHandler;
  detectIntentChooser(viewHierarchy: ViewHierarchyResult): boolean {
    return this.chooser.detectIntentChooser(viewHierarchy);
  }
  handleIntentChooser(
    viewHierarchy: ViewHierarchyResult,
    preference: "always" | "just_once" | "custom" = "just_once",
    customAppPackage?: string,
    url?: string,
  ): Promise<IntentChooserResult> {
    return this.chooser.handleIntentChooser(viewHierarchy, preference, customAppPackage, url);
  }
}
