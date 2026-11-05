import { PortReverseManager } from "./PortReverseManager";

/** The process's one owner map: the portReverse tool and the daemon's session cleanup share it. */
export const defaultPortReverseManager = new PortReverseManager();
