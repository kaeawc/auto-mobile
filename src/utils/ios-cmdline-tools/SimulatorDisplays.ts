import type { DeviceDisplays, DisplayPanel } from "../../models/DisplayPanel";
import { isIosDuoDeviceType } from "./iosDeviceType";

/** One integrated screen reported by `simctl io <udid> enumerate`. */
export interface SimulatorDisplay {
  id: string | null;
  name: string | null;
  width: number;
  height: number;
  uiScale: number | null;
  uiOrientation?: "Portrait" | "Landscape" | null;
}

/**
 * A non-integrated screen (`CarPlay`, `TVOut`, `Scene`, ...). Its `name` is the
 * `Device Name`, which `simctl io --display=` takes as the screen key.
 */
export interface SimulatorAuxiliaryScreen {
  screenType: string;
  id: string | null;
  name: string | null;
  width: number;
  height: number;
  uiScale: number | null;
}

/** Every sized screen in the Connected Screens block, split by screen type. */
export interface SimulatorScreens {
  integrated: SimulatorDisplay[];
  auxiliary: SimulatorAuxiliaryScreen[];
}

/** A CarPlay screen with the `--display=` key needed to capture it. */
export type SimulatorCarPlayScreen = SimulatorAuxiliaryScreen & { name: string };

type ScreenSection = Partial<SimulatorDisplay> & { screenType?: string };

const DISPLAY_FIELD_READERS = new Map<string, (section: ScreenSection, value: string) => void>([
  [
    "Screen ID",
    (section, value) => {
      section.id = value;
    },
  ],
  [
    "Device Name",
    (section, value) => {
      section.name = value;
    },
  ],
  [
    "Screen Type",
    (section, value) => {
      if (value) {
        section.screenType = value;
      }
    },
  ],
  [
    "Pixel Size",
    (section, value) => {
      const match = /^\{(\d+),\s*(\d+)\}$/.exec(value);
      if (match) {
        section.width = Number(match[1]);
        section.height = Number(match[2]);
      }
    },
  ],
  [
    "Preferred UI Scale",
    (section, value) => {
      const scale = Number(value);
      if (Number.isFinite(scale) && scale > 0) {
        section.uiScale = scale;
      }
    },
  ],
  [
    "UI Orientation",
    (section, value) => {
      if (value === "Portrait" || value === "Landscape") {
        section.uiOrientation = value;
      }
    },
  ],
]);

function readDisplayField(section: ScreenSection, line: string): void {
  const separator = line.indexOf(":");
  if (separator < 0) {
    return;
  }
  DISPLAY_FIELD_READERS.get(line.slice(0, separator))?.(section, line.slice(separator + 1).trim());
}

function addScreen(screens: SimulatorScreens, section: ScreenSection | null): void {
  if (!section?.screenType || !section.width || !section.height) {
    return;
  }
  const base = {
    id: section.id ?? null,
    name: section.name ?? null,
    width: section.width,
    height: section.height,
    uiScale: section.uiScale ?? null,
  };
  if (section.screenType === "Integrated") {
    screens.integrated.push({
      ...base,
      ...(section.uiOrientation ? { uiOrientation: section.uiOrientation } : {}),
    });
    return;
  }
  screens.auxiliary.push({ screenType: section.screenType, ...base });
}

/** Read every screen in the framebuffer server's Connected Screens block. */
export function parseSimulatorScreens(output: string): SimulatorScreens {
  const screens: SimulatorScreens = { integrated: [], auxiliary: [] };
  let section: ScreenSection | null = null;
  let displayAdapter = false;
  let framebufferServer = false;
  let connectedScreens = false;
  const finish = (): void => {
    addScreen(screens, section);
    section = null;
  };
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^Port:\s*$/.test(rawLine)) {
      finish();
      displayAdapter = false;
      framebufferServer = false;
      connectedScreens = false;
      continue;
    }
    if (line === "Class: DisplayAdapter") {
      displayAdapter = true;
    }
    if (line === "Port Identifier: com.apple.framebuffer.server") {
      framebufferServer = true;
    }
    if (displayAdapter && framebufferServer && line === "Connected Screens:") {
      connectedScreens = true;
      continue;
    }
    if (!connectedScreens) {
      continue;
    }
    if (/^\s+\(\d+\)\s+[^:]+:$/.test(rawLine)) {
      finish();
      section = {};
      continue;
    }
    if (section) {
      readDisplayField(section, line);
    }
  }
  finish();
  return screens;
}

/** Read Integrated entries in the framebuffer server's Connected Screens block. */
export function parseSimulatorDisplays(output: string): SimulatorDisplay[] {
  return parseSimulatorScreens(output).integrated;
}

/** The single named CarPlay screen, or null when there is none or more than one. */
export function findCarPlayScreen(
  screens: readonly SimulatorAuxiliaryScreen[],
): SimulatorCarPlayScreen | null {
  const carPlay = screens.filter((screen) => screen.screenType === "CarPlay");
  if (carPlay.length !== 1) {
    return null;
  }
  const [screen] = carPlay;
  return screen.name ? { ...screen, name: screen.name } : null;
}

/** The larger of the Duo's two Integrated screens is its inner panel. */
export function simulatorDeviceDisplays(
  displays: readonly SimulatorDisplay[],
  deviceTypeIdentifier?: string,
): DeviceDisplays | undefined {
  // Single-screen inventory keeps the existing JSON payload unchanged.
  if (displays.length < 2) {
    return undefined;
  }
  const areas = displays.map((display) => display.width * display.height);
  const largest = Math.max(...areas);
  const smallest = Math.min(...areas);
  const isDuo = isIosDuoDeviceType(deviceTypeIdentifier);
  const panels: DisplayPanel[] = displays.flatMap((display, index) => {
    if (!display.name) {
      return [];
    }
    const role =
      !isDuo || largest === smallest ? "unknown" : areas[index] === largest ? "inner" : "cover";
    return [
      {
        key: display.name,
        role,
        sizePx: { width: display.width, height: display.height },
        ...(display.uiScale ? { scale: display.uiScale } : {}),
      },
    ];
  });
  return panels.length > 1
    ? { panels, postures: isDuo ? ["closed", "half_opened", "opened"] : ["unknown"] }
    : undefined;
}

/** Select only when the live runner size identifies one screen unambiguously. */
export function selectLiveSimulatorDisplay(
  displays: readonly SimulatorDisplay[],
  pixelWidth: number,
  pixelHeight: number,
): SimulatorDisplay | null {
  const matches = displays.filter(
    (display) =>
      (display.width === pixelWidth && display.height === pixelHeight) ||
      (display.width === pixelHeight && display.height === pixelWidth),
  );
  return matches.length === 1 ? matches[0] : null;
}
