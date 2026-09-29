/** One integrated screen reported by `simctl io <udid> enumerate`. */
export interface SimulatorDisplay {
  id: string | null;
  name: string | null;
  width: number;
  height: number;
  uiScale: number | null;
}

function readDisplayField(section: Partial<SimulatorDisplay>, line: string): void {
  const separator = line.indexOf(":");
  if (separator < 0) {
    return;
  }
  const key = line.slice(0, separator);
  const value = line.slice(separator + 1).trim();
  if (key === "Screen ID") {
    section.id = value;
  }
  if (key === "Device Name") {
    section.name = value;
  }
  if (key === "Pixel Size") {
    const match = /^\{(\d+),\s*(\d+)\}$/.exec(value);
    if (match) {
      section.width = Number(match[1]);
      section.height = Number(match[2]);
    }
  }
  if (key === "Preferred UI Scale") {
    const scale = Number(value);
    if (Number.isFinite(scale) && scale > 0) {
      section.uiScale = scale;
    }
  }
}

/** Read Integrated entries in the framebuffer server's Connected Screens block. */
export function parseSimulatorDisplays(output: string): SimulatorDisplay[] {
  const displays: SimulatorDisplay[] = [];
  let section: Partial<SimulatorDisplay> | null = null;
  let integrated = false;
  let displayAdapter = false;
  let framebufferServer = false;
  let connectedScreens = false;
  const finish = (): void => {
    if (integrated && section?.width && section.height) {
      displays.push({
        id: section.id ?? null,
        name: section.name ?? null,
        width: section.width,
        height: section.height,
        uiScale: section.uiScale ?? null,
      });
    }
    section = null;
    integrated = false;
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
    if (!section) {
      continue;
    }
    if (line.startsWith("Screen Type:")) {
      integrated = line === "Screen Type: Integrated";
    }
    readDisplayField(section, line);
  }
  finish();
  return displays;
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
