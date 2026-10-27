import {
  DAEMON_PORT_RANGE_END,
  DAEMON_PORT_RANGE_START,
  DEFAULT_DAEMON_PORT,
} from "../../daemon/wire/constants";
import { PortManager } from "../../utils/PortManager";

/** Live set so coordinators created before daemon startup also see its configured HTTP port. */
const ports = new Set([
  DEFAULT_DAEMON_PORT,
  PortManager.DEVICE_PORT,
  ...Array.from(
    { length: DAEMON_PORT_RANGE_END - DAEMON_PORT_RANGE_START + 1 },
    (_, index) => DAEMON_PORT_RANGE_START + index,
  ),
]);
export const prototypeDaemonPorts: ReadonlySet<number> = ports;

/** Every daemon HTTP listener owned by this process remains subject to the egress policy. */
export function registerPrototypeDaemonPort(port: number): void {
  ports.add(port);
}
