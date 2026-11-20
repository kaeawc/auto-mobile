import type { BootedDevice, ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { ViewHierarchyParser } from "../../utils/ViewHierarchyParser";
import type { HealthSheetTap, HealthSheetUi, SheetElement } from "../../utils/ios/healthKitSeeder";
import {
  createObserveHierarchyReader,
  createTapOnTapper,
  type SystemAlertHierarchyReader,
  type SystemAlertTapper,
} from "../action/systemAlerts/SystemAlertGate";

const parser = new ViewHierarchyParser();

function stringAttr(attrs: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

const LABEL_KEYS = ["text", "ios-accessibility-label", "label", "content-desc"] as const;

/** Every node that carries an accessibility identifier, with its label. */
export function sheetElementsOf(hierarchy: ViewHierarchyResult): SheetElement[] {
  const elements: SheetElement[] = [];
  const roots = [
    ...parser.extractRootNodes(hierarchy),
    ...parser.extractWindowRootNodes(hierarchy),
  ];
  for (const root of roots) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attrs = parser.extractNodeProperties(node) as Record<string, unknown>;
      const elementId = stringAttr(attrs, ["resource-id"]);
      if (elementId) {
        const label = stringAttr(attrs, LABEL_KEYS);
        elements.push(label === undefined ? { elementId } : { elementId, label });
      }
    });
  }
  return elements;
}

export interface TapOnHealthSheetUiDependencies {
  reader?: SystemAlertHierarchyReader;
  tapper?: SystemAlertTapper;
}

/**
 * Drives the simulator's Health Access sheet in process: reads the hierarchy with `observe`
 * and taps with `tapOn`'s element resolution, outside the running tool's dispatch report.
 */
export class TapOnHealthSheetUi implements HealthSheetUi {
  private readonly reader: SystemAlertHierarchyReader;
  private readonly tapper: SystemAlertTapper;

  constructor(
    private readonly deviceFor: (udid: string) => BootedDevice,
    deps: TapOnHealthSheetUiDependencies = {},
  ) {
    this.reader = deps.reader ?? createObserveHierarchyReader();
    this.tapper = deps.tapper ?? createTapOnTapper();
  }

  async elements(udid: string): Promise<SheetElement[]> {
    const hierarchy = await this.reader.read(this.deviceFor(udid));
    return hierarchy ? sheetElementsOf(hierarchy) : [];
  }

  async tap(udid: string, selector: HealthSheetTap): Promise<void> {
    const result = await this.tapper.tap(this.deviceFor(udid), selector);
    if (!result.success) {
      throw new ActionableError(
        `Failed to tap ${JSON.stringify(selector)} on the Health Access sheet: ${result.error ?? "no match"}`,
      );
    }
  }
}

/** An iOS simulator addressed by UDID, as the seeder's runner addresses it. */
export function iosSimulatorByUdid(udid: string): BootedDevice {
  return { deviceId: udid, name: udid, platform: "ios" };
}
