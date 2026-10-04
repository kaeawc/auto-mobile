import type { BootedDevice, DisplayPanel, DisplayRef, ViewHierarchyResult } from "../../models";
import {
  buildDisconnectedPanelMessage,
  POSTURE_PANEL_ROLES,
  type Posture,
} from "../../models/DisplayPanel";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  parseAndroidCommittedStateIdentifier,
  parseAndroidDeviceStates,
} from "../../utils/android-cmdline-tools/AndroidDisplayInventory";
import {
  logicalDisplayIdForPanel,
  parseAndroidDisplayInfos,
} from "../../utils/android-cmdline-tools/AndroidDisplayParsers";
import { selectLiveSimulatorDisplay } from "../../utils/ios-cmdline-tools/SimulatorDisplays";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError } from "../../models/ActionableError";
import { DisplaySelectionError } from "./DisplaySelection";
import { selectedDisplayPin } from "./SessionDisplayContext";
import type { Timer } from "../../utils/SystemTimer";

export interface ObservedAndroidDisplay {
  display: DisplayRef;
  logicalId: number;
  panelKeysByLogicalId?: Readonly<Record<number, string>>;
}

export class AndroidDisplayReadError extends ActionableError {}

function singlePanelKeyOrDefault(panels: readonly DisplayPanel[]): string {
  return panels.length === 1 ? panels[0].key : "0";
}

async function readAndroidDisplayInfos(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<
  { infos: ReturnType<typeof parseAndroidDisplayInfos> } | { infos: null; reason: string }
> {
  try {
    const output = await adb.executeCommand(
      "shell cmd display get-displays",
      2000,
      undefined,
      true,
      signal,
    );
    signal?.throwIfAborted();
    return { infos: parseAndroidDisplayInfos(output.stdout) };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    // A failed live display-list read cannot establish whether a panel is connected.
    const reason = errorMessage(error);
    logger.warn(`Android display list could not be read: ${reason}`, error);
    return { infos: null, reason };
  }
}

interface CachedAndroidDisplay {
  inventory: string;
  value: ObservedAndroidDisplay;
  at: number;
}

const rememberedIosPostures = new Map<string, DisplayRef>();

const androidDisplayCache = new Map<string, CachedAndroidDisplay>();
const lastKnownAndroidDisplay = new Map<string, ObservedAndroidDisplay>();
const androidPostureCache = new Map<string, { inventory: string; at: number; posture: Posture }>();

function physicalPanelKey(uniqueId: string): string {
  return uniqueId.includes(":") ? uniqueId.split(":").slice(1).join(":") : uniqueId;
}

function postureForState(current: string, supported: string): Posture {
  const stateId = parseAndroidCommittedStateIdentifier(current);
  return (
    parseAndroidDeviceStates(supported).find((state) => state.identifier === stateId)?.posture ??
    "unknown"
  );
}

async function readAndroidPosture(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<Posture> {
  try {
    const [current, supported] = await Promise.all([
      adb.executeCommand("shell cmd device_state state", 2000, undefined, true, signal),
      adb.executeCommand("shell cmd device_state print-states", 2000, undefined, true, signal),
    ]);
    signal?.throwIfAborted();
    return postureForState(current.stdout, supported.stdout);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    // Device-state service is optional on Android devices without folding support.
    logger.debug(`Unable to read Android device posture: ${error}`);
    return "unknown";
  }
}

/** Reuse the panel mapping across observe instances and settle polls. */
export class ObservedAndroidDisplayCache {
  private static readonly TTL_MS = 5000;

  static clear(deviceId: string): void {
    rememberedIosPostures.delete(deviceId);
    androidDisplayCache.delete(deviceId);
    androidPostureCache.delete(deviceId);
  }

  static release(deviceId: string): void {
    rememberedIosPostures.delete(deviceId);
    androidDisplayCache.delete(deviceId);
    lastKnownAndroidDisplay.delete(deviceId);
    androidPostureCache.delete(deviceId);
  }

  static rememberIosPosture(deviceId: string, display: DisplayRef): void {
    rememberedIosPostures.set(deviceId, { ...display });
  }

  static iosPosture(device: BootedDevice, panel: DisplayPanel | undefined): Posture | undefined {
    const remembered = rememberedIosPostures.get(device.deviceId);
    if (
      remembered === undefined ||
      (device.displays?.panels.length ?? 0) < 2 ||
      resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator" ||
      (panel !== undefined && (panel.key !== remembered.key || panel.role !== remembered.role))
    ) {
      rememberedIosPostures.delete(device.deviceId);
      return undefined;
    }
    // An unknown panel cannot confirm the posture, but must preserve it for a later resolved read.
    return panel === undefined ? undefined : remembered.posture;
  }

  constructor(
    private readonly timer: Pick<Timer, "now">,
    private readonly readOnly = false,
  ) {}

  /** Resolve a physical panel to its current Android logical display id. */
  async logicalIdForPanel(
    device: BootedDevice,
    adb: Pick<AdbExecutor, "executeCommand">,
    key: string,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!device.displays?.panels.length && key === "0") {
      return 0;
    }
    const result = await readAndroidDisplayInfos(adb, signal);
    if (result.infos === null) {
      throw new AndroidDisplayReadError(
        `Android display list could not be read while selecting panel "${key}": ${result.reason}. Retry the request.`,
      );
    }
    const id = logicalDisplayIdForPanel(result.infos, key);
    if (id === undefined) {
      const panel = device.displays?.panels.find((candidate) => candidate.key === key) ?? {
        key,
        role: "unknown" as const,
      };
      const connectedPanels = result.infos.map((info) => {
        const key = physicalPanelKey(info.uniqueId ?? "") || info.logicalId;
        return {
          key,
          role:
            device.displays?.panels.find((candidate) => candidate.key === key)?.role ??
            ("unknown" as const),
        };
      });
      const hasPostures = (device.displays?.postures.length ?? 0) > 0;
      throw new DisplaySelectionError(
        buildDisconnectedPanelMessage(
          panel.key,
          panel.role,
          connectedPanels,
          hasPostures,
          selectedDisplayPin() !== undefined,
        ),
        { disconnectedPanel: { panel, connectedPanels, hasPostures } },
      );
    }
    return id;
  }

  /** The hierarchy reports the display of its focused window. */
  async panelForLogicalId(
    device: BootedDevice,
    adb: Pick<AdbExecutor, "executeCommand">,
    displayId: number | null | undefined,
    signal?: AbortSignal,
    panelUniqueId?: string | null,
    allowProbe = true,
  ): Promise<DisplayPanel | undefined> {
    const panels = device.displays?.panels ?? [];
    const direct = panels.find((panel) => panel.key === physicalPanelKey(panelUniqueId ?? ""));
    if (direct) {
      return direct;
    }
    if (typeof displayId !== "number") {
      return undefined;
    }
    const cachedKey = androidDisplayCache.get(device.deviceId)?.value.panelKeysByLogicalId?.[
      displayId
    ];
    if (cachedKey) {
      return panels.find((panel) => panel.key === cachedKey);
    }
    if (!allowProbe) {
      return undefined;
    }
    const result = await readAndroidDisplayInfos(adb, signal);
    if (result.infos === null) {
      return undefined;
    }
    const key = result.infos.find((info) => Number(info.logicalId) === displayId)?.uniqueId;
    return panels.find((panel) => panel.key === physicalPanelKey(key ?? ""));
  }

  /** Device state is sampled once per inventory or every 2 seconds; the injected timer controls expiry. */
  async posture(
    device: BootedDevice,
    adb: Pick<AdbExecutor, "executeCommand">,
    signal?: AbortSignal,
    force = false,
  ): Promise<Posture> {
    if ((device.displays?.panels.length ?? 0) < 2) {
      return "unknown";
    }
    const inventory = JSON.stringify(device.displays);
    const cached = androidPostureCache.get(device.deviceId);
    const age = cached === undefined ? Infinity : this.timer.now() - cached.at;
    if (!force && cached?.inventory === inventory && age >= 0 && age < 2_000) {
      return cached.posture;
    }
    const posture = await readAndroidPosture(adb, signal);
    if (!this.readOnly) {
      androidPostureCache.set(device.deviceId, { inventory, at: this.timer.now(), posture });
    }
    return posture;
  }

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
    const { value, cacheable } = await readObservedAndroidDisplay(
      device,
      adb,
      signal,
      lastKnownAndroidDisplay.get(device.deviceId),
    );
    signal?.throwIfAborted();
    this.cacheRead(device.deviceId, inventory, value, cacheable);
    return value;
  }

  private cacheRead(
    deviceId: string,
    inventory: string,
    value: ObservedAndroidDisplay,
    cacheable: boolean,
  ): void {
    if (this.readOnly) {
      return;
    }
    if (!cacheable) {
      // Even a forced read failure must let the next owner resolve retry immediately.
      androidDisplayCache.delete(deviceId);
      return;
    }
    lastKnownAndroidDisplay.set(deviceId, value);
    androidDisplayCache.set(deviceId, {
      inventory,
      value: { ...value, display: { ...value.display } },
      at: this.timer.now(),
    });
  }
}

/** Android's current observation capture is bound to logical display 0. */
export async function observedAndroidDisplay(
  device: BootedDevice,
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
  previous?: ObservedAndroidDisplay,
): Promise<ObservedAndroidDisplay> {
  return (await readObservedAndroidDisplay(device, adb, signal, previous)).value;
}

/** Keep read status private so best-effort fallbacks never become cached evidence. */
async function readObservedAndroidDisplay(
  device: BootedDevice,
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
  previous?: ObservedAndroidDisplay,
): Promise<{ value: ObservedAndroidDisplay; cacheable: boolean }> {
  const panels = device.displays?.panels;
  if (!panels?.length) {
    // Single-screen discovery omits its inventory; avoid a shell probe.
    return {
      value: {
        display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
        logicalId: 0,
      },
      cacheable: true,
    };
  }
  const result = await readAndroidDisplayInfos(adb, signal);
  const infos = result.infos ?? [];
  if (infos.length === 0 && previous) {
    return {
      value: { ...previous, display: { ...previous.display } },
      cacheable: result.infos !== null,
    };
  }
  return {
    value: {
      ...displayForAndroidInfos(panels, infos),
      panelKeysByLogicalId: Object.fromEntries(
        infos
          .filter((info) => info.uniqueId)
          .map((info) => [Number(info.logicalId), physicalPanelKey(info.uniqueId!)]),
      ),
    },
    cacheable: result.infos !== null,
  };
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
  hierarchy: Pick<ViewHierarchyResult, "pixelWidth" | "pixelHeight"> | undefined,
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

function iosPanelPosture(role: DisplayPanel["role"] | undefined): Posture {
  return POSTURE_PANEL_ROLES.find(([, panelRole]) => panelRole === role)?.[0] ?? "unknown";
}

/** Match the runner's live pixel size against the enumerated physical panels. */
export function observedIosDisplay(
  device: BootedDevice,
  hierarchy:
    | Pick<ViewHierarchyResult, "pixelWidth" | "pixelHeight" | "captureSequence">
    | undefined,
): DisplayRef {
  const panels = device.displays?.panels ?? [];
  const panel = liveIosPanel(panels, hierarchy);
  return {
    key: panel?.key ?? "0",
    role: panel?.role ?? "unknown",
    posture: ObservedAndroidDisplayCache.iosPosture(device, panel) ?? iosPanelPosture(panel?.role),
    // ObserveScreen stamps the tracker generation after recording the final display.
    generation: 0,
  };
}
