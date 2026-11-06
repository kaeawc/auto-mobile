import { defaultAdbReverseOwnership } from "./AdbReverseOwnership";
import { hostLoopbackProbeFor } from "./HostLoopbackProbe";
import { PortReverseManager } from "./PortReverseManager";
import { defaultTimer } from "../../utils/SystemTimer";

/**
 * The process's one owner map: the portReverse tool and the daemon's session cleanup share it, and
 * it shares port ownership with the prototype host's reverse manager (#17253).
 */
export const defaultPortReverseManager = new PortReverseManager(
  undefined,
  defaultTimer,
  hostLoopbackProbeFor(),
  defaultAdbReverseOwnership,
);
