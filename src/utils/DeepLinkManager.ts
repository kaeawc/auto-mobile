import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { shellQuote } from "./shellQuote";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "./android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import {
  DeepLinkResult,
  IntentFilter,
  DeepLinkInfo,
  IntentChooserResult,
  ViewHierarchyResult,
  BootedDevice,
  IosInfoPlist,
  ExecResult,
} from "../models";
import type { ElementParser } from "./interfaces/ElementParser";
import type { ElementGeometry } from "./interfaces/ElementGeometry";
import type { Element } from "../models/Element";
import type { Timer } from "./interfaces/Timer";
import { defaultTimer } from "./SystemTimer";
import { DefaultElementParser } from "../features/utility/ElementParser";
import { DefaultElementGeometry } from "../features/utility/ElementGeometry";
import { ViewHierarchy } from "../features/observe/ViewHierarchy";
import {
  STABLE_VIEW_ID_HASH_LENGTH,
  STABLE_VIEW_ID_PREFIX,
} from "../features/observe/android/StableNodeIdentity";
import { DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS } from "../features/action/ClearText";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorUdid } from "./ios-cmdline-tools/iosDeviceType";
import { PlistClient, type PlistReader } from "./ios-cmdline-tools/PlistClient";
import {
  AppBundleMetadataClient,
  type AppBundleMetadata,
} from "./ios-cmdline-tools/AppBundleMetadataClient";

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

const makeExecResult = (stdout: string, stderr: string): ExecResult => ({
  stdout,
  stderr,
  toString() {
    return stdout;
  },
  trim() {
    return stdout.trim();
  },
  includes(searchString: string) {
    return stdout.includes(searchString);
  },
});

const defaultHostExec: HostExec = async (file, args, stdin) => {
  const { execFile } = await import("child_process");
  return new Promise<ExecResult>((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      const out = typeof stdout === "string" ? stdout : stdout.toString();
      const err = typeof stderr === "string" ? stderr : stderr.toString();
      resolve(makeExecResult(out, err));
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
};

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
  ): Promise<IntentChooserResult>;
}

export interface ChooserAppMetadata {
  getLabel(device: BootedDevice, packageName: string): Promise<string | null>;
  getFreshHierarchy(
    device: BootedDevice,
    adbFactory: AdbClientFactory,
    minTimestamp: number,
  ): Promise<ViewHierarchyResult>;
}

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
// Bare content-derived IDs denote rows unique within a capture. Ordinal IDs
// and resource-backed IDs can be reassigned when a list scrolls or recycles.
const UNIQUE_CHOOSER_VIEW_ID = new RegExp(
  `^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}}$`,
);

const defaultChooserAppMetadata: ChooserAppMetadata = {
  async getLabel(device, packageName) {
    const { resolveAppLabel } = await import("../server/systemTrayHelpers");
    return resolveAppLabel(device, packageName);
  },
  async getFreshHierarchy(device, adbFactory, minTimestamp) {
    return new ViewHierarchy(device, adbFactory).getViewHierarchy(
      undefined,
      undefined,
      true,
      minTimestamp,
    );
  },
};

export class DeepLinkManager implements DeepLinkManager {
  private device: BootedDevice | null;
  private adbUtils: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private parser: ElementParser;
  private geometry: ElementGeometry;
  private simctl: SimCtlClient;
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
    simctl: SimCtlClient | null = null,
    hostExec: HostExec | null = null,
    plist: PlistReader = new PlistClient(),
    appBundleMetadata: AppBundleMetadata = new AppBundleMetadataClient(),
    private readonly chooserMetadata?: ChooserAppMetadata,
    private readonly timer: Timer = defaultTimer,
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

      // Check if the command failed (stderr indicates failure)
      if (packageInfoResult.stderr && packageInfoResult.stderr.trim().length > 0) {
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

      // Parse the results
      const deepLinks = this.parsePackageDumpsysOutput(appId, packageInfoResult.stdout);

      return {
        success: true,
        appId,
        deepLinks,
        rawOutput: packageInfoResult.stdout,
      };
    } catch (error) {
      logger.error(`[DeepLinkManager] Failed to get deep links for ${appId}: ${error}`);
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
    try {
      const udid = this.device!.deviceId;
      logger.info(`[DeepLinkManager] Querying iOS deep links for bundle: ${bundleId}`);

      if (!isIosSimulatorUdid(udid)) {
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
        appPath = container.stdout.trim();
      } catch (error) {
        logger.debug(`[DeepLinkManager] get_app_container failed for ${bundleId}: ${error}`);
      }
      if (!appPath) {
        return this.emptyIosResult(bundleId, `App ${bundleId} is not installed on ${udid}`);
      }

      // 2. Info.plist -> JSON via host plutil. argv form (no shell): the
      //    bundle path is a literal argument, so a crafted `.app` name cannot
      //    inject host commands.
      const info = (await this.plist.readJsonFile(`${appPath}/Info.plist`)) as IosInfoPlist;

      const schemes = this.parseCFBundleURLSchemes(info);
      const hosts = await this.parseAssociatedDomains(appPath, bundleId);
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
      };
    } catch (error) {
      logger.error(`[DeepLinkManager] Failed to get iOS deep links for ${bundleId}: ${error}`);
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
  private async parseAssociatedDomains(appPath: string, bundleId: string): Promise<string[]> {
    const entitlements = await this.appBundleMetadata.readEntitlements({
      appBundlePath: appPath,
      deviceId: this.device!.deviceId,
      bundleId,
    });
    const domains = entitlements?.["com.apple.developer.associated-domains"];
    if (!Array.isArray(domains)) {
      return [];
    }
    return domains
      .filter((d): d is string => typeof d === "string" && d.startsWith("applinks:"))
      .map((d) => d.slice("applinks:".length));
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
        if (
          line === "" ||
          line.startsWith("Non-Data Actions:") ||
          line.startsWith("Receiver Resolver Table:")
        ) {
          inSchemesSection = false;
          continue;
        }

        // Parse scheme entries (format: "scheme:")
        const schemeMatch = line.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):$/);
        if (schemeMatch) {
          const scheme = schemeMatch[1];
          schemes.add(scheme);

          // Look ahead for authority information
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            const authorityMatch = nextLine.match(/^([a-fA-F0-9]+)\s+.*filter\s+([a-fA-F0-9]+)$/);
            if (authorityMatch) {
              // Look for Authority line in the following lines
              for (let j = i + 2; j < Math.min(i + 10, lines.length); j++) {
                const authLine = lines[j].trim();
                const hostMatch = authLine.match(/^Authority:\s+"([^"]+)":\s*-?\d+$/);
                if (hostMatch) {
                  hosts.add(hostMatch[1]);
                  break;
                }
              }
            }
          }
        }
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

      if (inIntentFilterSection) {
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
          const authorityMatch = line.match(/^Authority:\s+"([^"]+)":\s*-?\d+$/);
          if (authorityMatch) {
            const host = authorityMatch[1];
            hosts.add(host);
            if (!currentFilter.data) {
              currentFilter.data = [];
            }
            // Find existing data entry with scheme or create new one
            const lastDataEntry = currentFilter.data[currentFilter.data.length - 1];
            if (lastDataEntry && !lastDataEntry.host) {
              lastDataEntry.host = host;
            } else {
              currentFilter.data.push({ host });
            }
          }
        }

        if (line.startsWith("Type:")) {
          const mimeType = line.replace("Type:", "").trim().replace(/"/g, "");
          supportedMimeTypes.add(mimeType);
          if (!currentFilter.data) {
            currentFilter.data = [];
          }
          currentFilter.data.push({ mimeType });
        }

        // End of current intent filter
        if (line === "" || (line.includes("filter") && line.includes("Action:"))) {
          if (currentFilter.action) {
            intentFilters.push(currentFilter as IntentFilter);
            currentFilter = {};
            inIntentFilterSection = false;
          }
        }
      }
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
  ): Promise<IntentChooserResult> {
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
        // Look for "Always" button
        for (const rootNode of rootNodes) {
          targetElement = this.findButtonByText(rootNode, ["Always", "ALWAYS"]);
          if (targetElement) {
            break;
          }
        }
      } else if (preference === "just_once") {
        // Look for "Just once" button
        for (const rootNode of rootNodes) {
          targetElement = this.findButtonByText(rootNode, ["Just once", "JUST ONCE", "Once"]);
          if (targetElement) {
            break;
          }
        }
      } else if (preference === "custom" && customAppPackage) {
        chooserMatch = await this.findAppInChooserAcrossPages(viewHierarchy, customAppPackage);
        targetElement = chooserMatch.element;
      }

      if (targetElement) {
        // Simulate tap on the target element
        const center = this.geometry.getElementCenter(targetElement);
        const tapResult = await this.adbUtils.executeCommand(
          `shell input tap ${center.x} ${center.y}`,
        );

        // Check if tap command failed
        if (tapResult.stderr && tapResult.stderr.trim().length > 0) {
          logger.error(
            `[DeepLinkManager] Failed to tap on intent chooser option: ${tapResult.stderr}`,
          );
          return {
            success: false,
            detected: true,
            error: tapResult.stderr,
            packageVerified: chooserMatch?.packageVerified,
          };
        }

        logger.info(
          `[DeepLinkManager] Tapped on intent chooser option at (${center.x}, ${center.y})`,
        );

        const tapTimestamp =
          chooserMatch && !chooserMatch.packageVerified
            ? await this.getChooserTapFreshnessFloor()
            : undefined;
        const tappedAt = tapTimestamp?.floor;
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
      } else {
        return {
          success: false,
          detected: true,
          error: `Could not find target element for preference: ${preference}`,
        };
      }
    } catch (error) {
      logger.error(`[DeepLinkManager] Failed to handle intent chooser: ${error}`);
      return {
        success: false,
        detected: true,
        error: errorMessage(error),
        packageVerified: chooserMatch?.packageVerified,
      };
    }
  }

  private async getChooserTapFreshnessFloor(): Promise<
    { floor: number; deviceSeconds: boolean } | undefined
  > {
    const timestampResult = await this.adbUtils.getDeviceTimestampMsWithSource();
    if (timestampResult.source === "host") {
      return undefined;
    }
    const deviceSeconds = timestampResult.source === "device-seconds";
    return {
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
    for (;;) {
      const observed = await metadata.getFreshHierarchy(this.device!, this.adbFactory, floor);
      if (
        observed.updatedAt !== undefined &&
        observed.updatedAt >=
          floor - (deviceSeconds ? DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS : 0) &&
        observed.packageName === appPackage &&
        !this.hasResolverHostEvidence(observed)
      ) {
        return true;
      }
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        return false;
      }
      floor = deviceSeconds
        ? Math.max(floor, (observed.updatedAt ?? floor - 1) + 1)
        : Math.max(floor, observed.updatedAt ?? floor) + 1;
      await this.timer.sleep(Math.min(POST_TAP_VERIFY_INTERVAL_MS, remaining));
    }
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
      );
    }
    return this.selectUniqueChooserRow(candidates, labelRows, appPackage, true);
  }

  private async findAppInChooserAcrossPages(
    initialHierarchy: ViewHierarchyResult,
    appPackage: string,
  ): Promise<ChooserMatch> {
    const metadata = this.chooserMetadata ?? defaultChooserAppMetadata;
    let hierarchy = initialHierarchy;
    const matches = new Map<string, ChooserMatch>();
    let missing: ChooserRowMissingError | undefined;
    let matchingPage = -1;
    let currentPage = 0;
    let previousMatch: { page: number; key: string; match: ChooserMatch } | undefined;
    let previousSwipeDistance = 0;
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
        );
        previousMatch = this.recordChooserMatch(
          matches,
          previousMatch,
          match,
          page,
          previousSwipeDistance,
        );
        matchingPage = page;
      } catch (error) {
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
      previousSwipeDistance = next.swipeDistance;
      hierarchy = next.hierarchy;
    }
    const unique = this.selectUniqueAcrossPages(matches, missing, appPackage);
    if (matchingPage === currentPage) {
      return unique;
    }
    return this.restoreChooserPage(hierarchy, appPackage, unique, metadata);
  }

  private recordChooserMatch(
    matches: Map<string, ChooserMatch>,
    previous: { page: number; key: string; match: ChooserMatch } | undefined,
    match: ChooserMatch,
    page: number,
    swipeDistance: number,
  ): { page: number; key: string; match: ChooserMatch } {
    const sameRow =
      previous?.page === page - 1 &&
      this.isChooserRowSlidingAcrossSwipe(previous.match, match, swipeDistance);
    const key = sameRow && previous ? previous.key : `page:${page}`;
    matches.set(key, match);
    return { page, key, match };
  }

  private isChooserRowSlidingAcrossSwipe(
    previous: ChooserMatch,
    current: ChooserMatch,
    swipeDistance: number,
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
      Math.abs(before.top - after.top - swipeDistance) <= 1 &&
      Math.abs(before.bottom - after.bottom - swipeDistance) <= 1
    );
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
  ): Promise<{ match?: ChooserMatch; capturedAt?: number }> {
    try {
      const match = await this.findAppInChooser(
        this.parser.extractRootNodes(hierarchy),
        appPackage,
        hierarchy.packageName,
        undefined,
        hierarchy.updatedAt,
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
      const result = await this.findMatchingChooserRow(hierarchy, appPackage, expected);
      if (result.match) {
        return result.match;
      }
      capturedAt = result.capturedAt;
    }
    throw new Error(
      `Could not restore the unique chooser row for ${appPackage} after checking all pages.`,
    );
  }

  private async scrollChooserList(
    hierarchy: ViewHierarchyResult,
    roots: any[],
    metadata: ChooserAppMetadata,
    appPackage: string,
    capturedAt?: number,
    direction: "up" | "down" = "up",
  ): Promise<{ hierarchy: ViewHierarchyResult; swipeDistance: number } | null> {
    const list = this.findChooserList(roots);
    if (!list || list.bounds.bottom - list.bounds.top < 40) {
      return null;
    }
    const centerX = Math.round((list.bounds.left + list.bounds.right) / 2);
    const height = list.bounds.bottom - list.bounds.top;
    const lowerY = Math.round(list.bounds.bottom - height / 4);
    const upperY = Math.round(list.bounds.top + height / 4);
    const [fromY, toY] = direction === "up" ? [lowerY, upperY] : [upperY, lowerY];
    const swipe = await this.adbUtils.executeCommand(
      `shell input swipe ${centerX} ${fromY} ${centerX} ${toY} 350`,
    );
    if (swipe.stderr?.trim()) {
      throw new Error(`Could not scroll chooser app list: ${swipe.stderr.trim()}`);
    }
    const nextTimestamp = Math.max(hierarchy.updatedAt ?? 0, capturedAt ?? 0) + 1;
    const fresh = await metadata.getFreshHierarchy(this.device!, this.adbFactory, nextTimestamp);
    this.validateScrolledChooser(fresh, nextTimestamp, appPackage);
    return JSON.stringify(fresh.hierarchy) === JSON.stringify(hierarchy.hierarchy)
      ? null
      : { hierarchy: fresh, swipeDistance: fromY - toY };
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

  private async findChooserLabelFallback(
    appPackage: string,
    labelRows: Map<any, Set<string>>,
    rowsWithPackageMetadata: Set<any>,
    resolvedLabel: string | null | undefined,
    originalUpdatedAt?: number,
  ): Promise<ChooserMatch> {
    if (resolvedLabel === undefined) {
      if (originalUpdatedAt === undefined) {
        throw new Error(
          `Cannot safely refresh chooser for ${appPackage} without a capture timestamp.`,
        );
      }
      const metadata = this.chooserMetadata ?? defaultChooserAppMetadata;
      const label = await metadata.getLabel(this.device!, appPackage);
      const freshHierarchy = await metadata.getFreshHierarchy(
        this.device!,
        this.adbFactory,
        originalUpdatedAt + 1,
      );
      if (freshHierarchy.updatedAt === undefined || freshHierarchy.updatedAt <= originalUpdatedAt) {
        throw new Error(`Chooser hierarchy did not refresh after resolving ${appPackage}.`);
      }
      if (!this.detectIntentChooser(freshHierarchy)) {
        throw new Error(`Intent chooser disappeared while resolving ${appPackage}.`);
      }
      try {
        const match = await this.findAppInChooser(
          this.parser.extractRootNodes(freshHierarchy),
          appPackage,
          freshHierarchy.packageName,
          label,
        );
        return { ...match, capturedAt: freshHierarchy.updatedAt };
      } catch (error) {
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

  private selectUniqueChooserRow(
    candidates: any[],
    labelRows: Map<any, Set<string>>,
    appPackage: string,
    packageVerified: boolean,
  ): ChooserMatch {
    if (candidates.length > 1) {
      const descriptions = candidates.map((row, index) => {
        const properties = this.parser.extractNodeProperties(row);
        return `${index + 1}: ${[...(labelRows.get(row) ?? [])].join(" / ")} bounds=${JSON.stringify(properties.bounds)}`;
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
