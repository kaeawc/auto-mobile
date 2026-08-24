import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
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
import { DefaultElementParser } from "../features/utility/ElementParser";
import { DefaultElementGeometry } from "../features/utility/ElementGeometry";
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

  constructor(
    device: BootedDevice | null = null,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    simctl: SimCtlClient | null = null,
    hostExec: HostExec | null = null,
    plist: PlistReader = new PlistClient(),
    appBundleMetadata: AppBundleMetadata = new AppBundleMetadataClient(),
  ) {
    // Detect if the argument is a factory (has create method) or an executor
    if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      this.adbFactory = adbFactoryOrExecutor as AdbClientFactory;
      this.adbUtils = this.adbFactory.create(device);
    } else if (adbFactoryOrExecutor) {
      // Legacy path: wrap the executor in a factory for downstream dependencies
      const executor = adbFactoryOrExecutor as AdbExecutor;
      this.adbUtils = executor;
      this.adbFactory = { create: () => executor };
    } else {
      this.adbFactory = defaultAdbClientFactory;
      this.adbUtils = this.adbFactory.create(device);
    }
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
        `shell dumpsys package ${appId}`,
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
        // Look for specific app in the list
        for (const rootNode of rootNodes) {
          targetElement = this.findAppInChooser(rootNode, customAppPackage);
          if (targetElement) {
            break;
          }
        }
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
          };
        }

        logger.info(
          `[DeepLinkManager] Tapped on intent chooser option at (${center.x}, ${center.y})`,
        );

        return {
          success: true,
          detected: true,
          action: preference,
          appSelected: customAppPackage,
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
      };
    }
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
   * @param node - Root node to search from
   * @param appPackage - App package to find
   * @returns Found element or null
   */
  private findAppInChooser(node: any, appPackage: string): any {
    let foundElement: any = null;

    this.parser.traverseNode(node, (currentNode: any) => {
      if (foundElement) {
        return;
      } // Already found

      const properties = this.parser.extractNodeProperties(currentNode);
      const resourceId = properties["resource-id"] || "";
      const text = properties.text || properties["content-desc"] || "";

      // Check if this element references the target app
      if (resourceId.includes(appPackage) || text.includes(appPackage)) {
        foundElement = currentNode;
      }
    });

    return foundElement;
  }
}
