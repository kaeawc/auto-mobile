import { describe, expect, test } from "bun:test";
import { findAvailableDaemonPort } from "../../src/daemon/daemon";
import { DAEMON_PORT_RANGE_END, DAEMON_PORT_RANGE_START } from "../../src/daemon/constants";

function probe(free: readonly number[]) {
  const probed: number[] = [];
  const isPortAvailable = async (port: number) => {
    probed.push(port);
    return free.includes(port);
  };
  return { probed, isPortAvailable };
}

describe("findAvailableDaemonPort", () => {
  test("returns the preferred port without probing others", async () => {
    const { probed, isPortAvailable } = probe([3000]);
    expect(await findAvailableDaemonPort(3000, isPortAvailable)).toBe(3000);
    expect(probed).toEqual([3000]);
  });

  test("scans past preferred+3 to the end of the documented range", async () => {
    const { isPortAvailable } = probe([DAEMON_PORT_RANGE_END]);
    expect(await findAvailableDaemonPort(DAEMON_PORT_RANGE_START, isPortAvailable)).toBe(
      DAEMON_PORT_RANGE_END,
    );
  });

  test("wraps to ports below the preferred one before giving up", async () => {
    const { probed, isPortAvailable } = probe([3001]);
    expect(await findAvailableDaemonPort(3008, isPortAvailable)).toBe(3001);
    expect(probed).toEqual([3008, 3009, 3010, 3000, 3001]);
  });

  test("throws the range error only after every in-range port is probed", async () => {
    const { probed, isPortAvailable } = probe([]);
    await expect(findAvailableDaemonPort(3000, isPortAvailable)).rejects.toThrow(
      `No available ports in range ${DAEMON_PORT_RANGE_START}-${DAEMON_PORT_RANGE_END}`,
    );
    expect([...probed].sort((a, b) => a - b)).toEqual(
      Array.from(
        { length: DAEMON_PORT_RANGE_END - DAEMON_PORT_RANGE_START + 1 },
        (_, i) => DAEMON_PORT_RANGE_START + i,
      ),
    );
  });

  test("a preferred port outside the range has no fallback", async () => {
    const { probed, isPortAvailable } = probe([3000]);
    await expect(findAvailableDaemonPort(8080, isPortAvailable)).rejects.toThrow(
      "Port 8080 is not available",
    );
    expect(probed).toEqual([8080]);
  });
});
