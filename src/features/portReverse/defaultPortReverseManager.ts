import { hostLoopbackProbeFor } from "./HostLoopbackProbe";
import { PortReverseManager } from "./PortReverseManager";
import { defaultTimer } from "../../utils/SystemTimer";

/** The process's one owner map: the portReverse tool and the daemon's session cleanup share it. */
export const defaultPortReverseManager = new PortReverseManager(
  undefined,
  defaultTimer,
  hostLoopbackProbeFor(),
);
