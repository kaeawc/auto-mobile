import type { BootedDevice, DisplayPanel, DisplayRef, ViewHierarchyResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  logicalDisplayIdForPanel,
  parseAndroidDisplayInfos,
} from "../../utils/android-cmdline-tools/AndroidDisplayParsers";
import { selectLiveSimulatorDisplay } from "../../utils/ios-cmdline-tools/SimulatorDisplays";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

export interface ObservedAndroidDisplay {
  display: DisplayRef;
  logicalId: number;
}

function singlePanelKeyOrDefault(panels: readonly DisplayPanel[]): string {
  return panels.length === 1 ? panels[0].key : "0";
}

async function readAndroidDisplayInfos(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<ReturnType<typeof parseAndroidDisplayInfos>> {
  try {
    const output = await adb.executeCommand(
      "shell cmd display get-displays",
      2000,
      undefined,
      true,
      signal,
    );
    signal?.throwIfAborted();
    return parseAndroidDisplayInfos(output.stdout);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    // Older Android versions may lack this optional inventory command.
    logger.debug(`Unable to map observed Android panel: ${error}`);
    return [];
  }
}

interface CachedAndroidDisplay {
  inventory: string;
  value: ObservedAndroidDisplay;
  at: number;
}

const androidDisplayCache = new Map<string, CachedAndroidDisplay>();
const lastKnownAndroidDisplay = new Map<string, ObservedAndroidDisplay>();

/** Reuse the panel mapping across observe instances and settle polls. */
export class ObservedAndroidDisplayCache {
  private static readonly TTL_MS = 5000;

  static clear(deviceId: string): void {
    androidDisplayCache.delete(deviceId);
  }

  static release(deviceId: string): void {
    androidDisplayCache.delete(deviceId);
    lastKnownAndroidDisplay.delete(deviceId);
  }

  constructor(private readonly timer: Pick<Timer, "now">) {}

  async resolve(
    device: BootedDevice,
    adb: Pick<AdbExecutor, "executeCommand">,
    signal?: AbortSignal,
    force = false,
  ): Promise<ObservedAndroidDisplay> {
    signal?.throwIfAborted();
    const inventory = JSON.stringify(device.displays ?? null);
    const cached = androidDisplayCache.get(device.deviceId);
    const age = cached === undefined ? Infinity : this.timer.now() - cached.at;
    if (
      cached !== undefined &&
      cached.inventory === inventory &&
      age >= 0 &&
      age < ObservedAndroidDisplayCache.TTL_MS &&
      !force
    ) {
      return { ...cached.value, display: { ...cached.value.display } };
    }
    const value = await observedAndroidDisplay(
      device,
      adb,
      signal,
      lastKnownAndroidDisplay.get(device.deviceId),
    );
    signal?.throwIfAborted();
    lastKnownAndroidDisplay.set(device.deviceId, value);
    androidDisplayCache.set(device.deviceId, {
      inventory,
      value: { ...value, display: { ...value.display } },
      at: this.timer.now(),
    });
    return value;
  }
}

/** Android's current observation capture is bound to logical display 0. */
export async function observedAndroidDisplay(
  device: BootedDevice,
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
  previous?: ObservedAndroidDisplay,
): Promise<ObservedAndroidDisplay> {
  const panels = device.displays?.panels;
  if (!panels?.length) {
    // Single-screen discovery omits its inventory; avoid a shell probe.
    return {
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      logicalId: 0,
    };
  }
  const infos = await readAndroidDisplayInfos(adb, signal);
  if (infos.length === 0 && previous) {
    return { ...previous, display: { ...previous.display } };
  }
  return displayForAndroidInfos(panels, infos);
}

function displayForAndroidInfos(
  panels: readonly DisplayPanel[],
  infos: ReturnType<typeof parseAndroidDisplayInfos>,
): ObservedAndroidDisplay {
  const physicalKey = infos
    .find((info) => info.logicalId === "0")
    ?.uniqueId?.split(":")
    .slice(1)
    .join(":");
  const panel = panels.find((candidate) => candidate.key === physicalKey);
  // Single-panel inventories are omitted by discovery. "0" is the stable
  // logical-display fallback; role and posture stay unknown without evidence.
  const key = panel?.key ?? physicalKey ?? singlePanelKeyOrDefault(panels);
  const logicalId = logicalDisplayIdForPanel(infos, key) ?? 0;
  return {
    display: { key, role: panel?.role ?? "unknown", posture: "unknown", generation: 0 },
    logicalId,
  };
}

function liveIosPanel(
  panels: readonly DisplayPanel[],
  hierarchy: ViewHierarchyResult | undefined,
): DisplayPanel | undefined {
  if (!hierarchy?.pixelWidth || !hierarchy.pixelHeight) {
    return panels.length === 1 ? panels[0] : undefined;
  }
  const selected = selectLiveSimulatorDisplay(
    panels.map((panel) => ({
      id: panel.key,
      name: panel.key,
      width: panel.sizePx.width,
      height: panel.sizePx.height,
      uiScale: panel.scale ?? null,
    })),
    hierarchy.pixelWidth,
    hierarchy.pixelHeight,
  );
  return panels.find((candidate) => candidate.key === selected?.name);
}

/** Match the runner's live pixel size against the enumerated physical panels. */
export function observedIosDisplay(
  device: BootedDevice,
  hierarchy: ViewHierarchyResult | undefined,
): DisplayRef {
  const panels = device.displays?.panels ?? [];
  const panel = liveIosPanel(panels, hierarchy);
  return {
    key: panel?.key ?? "0",
    role: panel?.role ?? "unknown",
    posture: "unknown",
    // The runner hierarchy carries the forwarded capture identity when one
    // exists. Zero is the explicit no-sequence fallback, not a new counter.
    generation: hierarchy?.captureSequence ?? 0,
  };
}
