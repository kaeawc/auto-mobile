import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../utils/logger";
import type { TouchInputNode } from "./TouchNodeDiscovery";

const ABS_X = 0x00;
const ABS_Y = 0x01;
const ABS_PRESSURE = 0x18;
const ABS_MT_POSITION_X = 0x35;
const ABS_MT_POSITION_Y = 0x36;
const ABS_MT_PRESSURE = 0x3a;

interface AbsRange {
  min: number;
  max: number;
}

interface DeviceInfo {
  path: string;
  name: string;
  abs: Map<number, AbsRange>;
  hasPenTool: boolean;
}

export interface InputNodes {
  /** First multitouch node (the one recording uses). */
  touch: TouchInputNode | null;
  /** Nodes with single-touch ABS_X/Y plus a pen tool (BTN_TOOL_PEN / BTN_TOOL_RUBBER). */
  pen: TouchInputNode[];
}

/** Run `shell getevent -p` and classify the nodes into touch and pen digitizers. */
export async function discoverInputNodes(adb: AdbExecutor): Promise<InputNodes> {
  const { stdout } = await adb.executeCommand("shell getevent -p");
  const nodes = parseInputNodes(stdout);
  if (nodes.touch === null && nodes.pen.length === 0) {
    logger.warn("[InputNodeDiscovery] No multitouch or pen input device found");
  }
  return nodes;
}

/**
 * Pure parser exposed for unit testing; the single `getevent -p` parser in the
 * repo. Handles `getevent -p` (hex codes) and `getevent -lp` (named codes),
 * including the first axis that real output prints on the `ABS (0003):` line.
 * `touch` is the first node that reports ABS_MT_POSITION_X/Y; `pen` holds nodes
 * without them that report ABS_X/ABS_Y and a pen tool key. Accelerometers
 * report ABS_X/Y but no pen tool, so they are not mistaken for a digitizer.
 */
export function parseInputNodes(output: string): InputNodes {
  const nodes = parseNodes(output);
  return {
    touch: nodes.find((node) => node.kind === "touch") ?? null,
    pen: nodes.filter((node) => node.kind === "pen"),
  };
}

/** Every multitouch node in `output`, in order (a capture may list the same node twice). */
export function parseTouchNodes(output: string): TouchInputNode[] {
  return parseNodes(output).filter((node) => node.kind === "touch");
}

function parseNodes(output: string): TouchInputNode[] {
  const nodes: TouchInputNode[] = [];
  for (const device of splitDevices(output)) {
    const mtX = device.abs.get(ABS_MT_POSITION_X);
    const mtY = device.abs.get(ABS_MT_POSITION_Y);
    if (mtX && mtY) {
      nodes.push(toNode(device, mtX, mtY, device.abs.get(ABS_MT_PRESSURE), "touch"));
      continue;
    }
    const x = device.abs.get(ABS_X);
    const y = device.abs.get(ABS_Y);
    if (x && y && device.hasPenTool) {
      nodes.push(toNode(device, x, y, device.abs.get(ABS_PRESSURE), "pen"));
    }
  }
  return nodes;
}

function toNode(
  device: DeviceInfo,
  x: AbsRange,
  y: AbsRange,
  pressure: AbsRange | undefined,
  kind: "touch" | "pen",
): TouchInputNode {
  return {
    path: device.path,
    name: device.name,
    axisXMin: x.min,
    axisXMax: x.max,
    axisYMin: y.min,
    axisYMax: y.max,
    kind,
    ...(pressure && pressure.max > pressure.min
      ? { pressureMin: pressure.min, pressureMax: pressure.max }
      : {}),
  };
}

// BTN_TOOL_PEN = 0x140, BTN_TOOL_RUBBER = 0x141
const PEN_TOOL_KEY = /\b(?:BTN_TOOL_PEN|BTN_TOOL_RUBBER|0140|0141)\b/;
const NAME_TO_CODE: Record<string, number> = {
  ABS_X: ABS_X,
  ABS_Y: ABS_Y,
  ABS_PRESSURE: ABS_PRESSURE,
  ABS_MT_POSITION_X: ABS_MT_POSITION_X,
  ABS_MT_POSITION_Y: ABS_MT_POSITION_Y,
  ABS_MT_PRESSURE: ABS_MT_PRESSURE,
};
// One absinfo entry, with an optional leading "ABS (0003):" block header (real output prints the
// first axis there) and either a hex code or an ABS_* name (optionally followed by "(hex)"):
//   "    ABS (0003): 0000  : value 0, min 0, max 32767, ..."
//   "                0035  : value 0, ..."
//   "    ABS (0003): ABS_X                 : value 0, ..."
//   "    ABS_MT_POSITION_X (0035): value 0, ..."
const ABSINFO =
  /^\s*(?:ABS\s*\(0003\):\s*)?(?:(ABS_\w+)(?:\s+\(([0-9a-f]{4})\))?|([0-9a-f]{4}))\s*:\s+value\s+-?\d+,\s*min\s+(-?\d+),\s*max\s+(-?\d+)/;
// An event-type block header such as "    KEY (0001): ..." or "    SW  (0005): ...".
const BLOCK_HEADER = /^\s+(\w+)\s*\([0-9a-f]{4}\):(.*)$/;

function absCode(match: RegExpMatchArray): number | undefined {
  const hex = match[2] ?? match[3];
  return hex ? parseInt(hex, 16) : NAME_TO_CODE[match[1]];
}

function splitDevices(output: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  let current: DeviceInfo | null = null;
  const state = { inKeyBlock: false };
  for (const line of output.split("\n")) {
    const deviceMatch = line.match(/^add device \d+:\s+(.+)/);
    if (deviceMatch) {
      const path = deviceMatch[1].trim();
      current = { path, name: path, abs: new Map(), hasPenTool: false };
      devices.push(current);
      state.inKeyBlock = false;
    } else if (current) {
      applyLine(current, line, state);
    }
  }
  return devices;
}

function applyLine(device: DeviceInfo, line: string, state: { inKeyBlock: boolean }): void {
  const nameMatch = line.match(/^\s+name:\s+"(.+)"/);
  if (nameMatch) {
    device.name = nameMatch[1];
    state.inKeyBlock = false;
    return;
  }
  const absMatch = line.match(ABSINFO);
  if (absMatch) {
    const code = absCode(absMatch);
    if (code !== undefined) {
      device.abs.set(code, { min: parseInt(absMatch[4], 10), max: parseInt(absMatch[5], 10) });
    }
    state.inKeyBlock = false;
    return;
  }
  const header = line.match(BLOCK_HEADER);
  if (header) {
    state.inKeyBlock = header[1] === "KEY" || header[1] === "EV_KEY";
    if (state.inKeyBlock && PEN_TOOL_KEY.test(header[2])) {
      device.hasPenTool = true;
    }
    return;
  }
  // Continuation lines of the KEY block hold only key codes or names.
  const codesOnly = /^\s+[\w ]+$/.test(line);
  if (state.inKeyBlock && codesOnly && PEN_TOOL_KEY.test(line)) {
    device.hasPenTool = true;
  } else if (!codesOnly) {
    state.inKeyBlock = false;
  }
}
