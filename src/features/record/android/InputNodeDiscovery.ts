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
  /** First multitouch node, as discoverTouchNode picks. */
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
 * Pure parser exposed for unit testing. Handles `getevent -p` (hex codes) and
 * `getevent -pl` (named codes). A node that reports ABS_MT_POSITION_X/Y is a
 * touch node (and is the only one returned as `touch`, the first); a node
 * without them that reports ABS_X/ABS_Y and a pen tool key is a pen node.
 * Accelerometers and the like report ABS_X/Y but no pen tool, so they are
 * not mistaken for a digitizer. Pressure ranges (ABS_MT_PRESSURE for touch,
 * ABS_PRESSURE for pen) are attached when the device reports them.
 */
export function parseInputNodes(output: string): InputNodes {
  const devices = splitDevices(output);
  let touch: TouchInputNode | null = null;
  const pen: TouchInputNode[] = [];
  for (const device of devices) {
    const mtX = device.abs.get(ABS_MT_POSITION_X);
    const mtY = device.abs.get(ABS_MT_POSITION_Y);
    if (mtX && mtY) {
      touch ??= toNode(device, mtX, mtY, device.abs.get(ABS_MT_PRESSURE), "touch");
      continue;
    }
    const x = device.abs.get(ABS_X);
    const y = device.abs.get(ABS_Y);
    if (x && y && device.hasPenTool) {
      pen.push(toNode(device, x, y, device.abs.get(ABS_PRESSURE), "pen"));
    }
  }
  return { touch, pen };
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
// absinfo: "    0035  : value 0, min 0, max 1079, ..." or "    ABS_MT_POSITION_X (0035): value ..."
const ABSINFO =
  /^\s*(?:ABS_\w+\s+\()?([0-9a-f]{4})\)?\s*:\s+value\s+-?\d+,\s*min\s+(-?\d+),\s*max\s+(-?\d+)/;

function splitDevices(output: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  let current: DeviceInfo | null = null;
  for (const line of output.split("\n")) {
    const deviceMatch = line.match(/^add device \d+:\s+(.+)/);
    if (deviceMatch) {
      const path = deviceMatch[1].trim();
      current = { path, name: path, abs: new Map(), hasPenTool: false };
      devices.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const nameMatch = line.match(/^\s+name:\s+"(.+)"/);
    if (nameMatch) {
      current.name = nameMatch[1];
      continue;
    }
    const absMatch = line.match(ABSINFO);
    if (absMatch) {
      current.abs.set(parseInt(absMatch[1], 16), {
        min: parseInt(absMatch[2], 10),
        max: parseInt(absMatch[3], 10),
      });
      continue;
    }
    // Event-capability lines never contain "value"; absinfo lines were handled above.
    if (!line.includes("value") && PEN_TOOL_KEY.test(line)) {
      current.hasPenTool = true;
    }
  }
  return devices;
}
