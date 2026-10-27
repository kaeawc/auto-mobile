import { DAEMON_PORT_RANGE_START, DAEMON_PORT_RANGE_END } from "./wire/constants";

/**
 * Pick the daemon's HTTP port: the preferred port first, then each higher port up to
 * `DAEMON_PORT_RANGE_END`. The scan never goes below the preferred port, so a daemon started
 * on a non-default port can never take `DEFAULT_DAEMON_PORT`, the port the shared daemon's
 * restart insists on (`strictPort`). A preferred port outside the
 * `DAEMON_PORT_RANGE_START`-`DAEMON_PORT_RANGE_END` range has no fallback.
 */
export async function findAvailableDaemonPort(
  preferredPort: number,
  isPortAvailable: (port: number) => Promise<boolean>,
): Promise<number> {
  if (await isPortAvailable(preferredPort)) {
    return preferredPort;
  }
  const inRange =
    preferredPort >= DAEMON_PORT_RANGE_START && preferredPort <= DAEMON_PORT_RANGE_END;
  const fallbacks = inRange
    ? Array.from(
        { length: DAEMON_PORT_RANGE_END - preferredPort },
        (_, index) => preferredPort + 1 + index,
      )
    : [];
  for (const port of fallbacks) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  if (!inRange) {
    throw new Error(
      `Port ${preferredPort} is not available (outside the fallback range ${DAEMON_PORT_RANGE_START}-${DAEMON_PORT_RANGE_END})`,
    );
  }
  throw new Error(
    fallbacks.length === 0
      ? `Port ${preferredPort} is not available (no higher port in the fallback range ${DAEMON_PORT_RANGE_START}-${DAEMON_PORT_RANGE_END})`
      : `No available ports in range ${preferredPort}-${DAEMON_PORT_RANGE_END}`,
  );
}
