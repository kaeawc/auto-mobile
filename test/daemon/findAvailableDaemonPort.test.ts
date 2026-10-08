import { describe, expect, test } from "bun:test";
import { findAvailableDaemonPort } from "../../src/daemon/daemon";
import {
  DAEMON_PORT_RANGE_END,
  DAEMON_PORT_RANGE_START,
  DEFAULT_DAEMON_PORT,
} from "../../src/daemon/constants";

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

  test("scans upward only: a non-default preferred port never falls back to the default", async () => {
    const { probed, isPortAvailable } = probe([DEFAULT_DAEMON_PORT, 3001]);
    await expect(findAvailableDaemonPort(3008, isPortAvailable)).rejects.toThrow(
      `No available ports in range 3008-${DAEMON_PORT_RANGE_END}`,
    );
    expect(probed).toEqual([3008, 3009, 3010]);
    expect(probed).not.toContain(DEFAULT_DAEMON_PORT);
  });

  test("falls back to the next free higher port", async () => {
    const { probed, isPortAvailable } = probe([3001, 3009]);
    expect(await findAvailableDaemonPort(3008, isPortAvailable)).toBe(3009);
    expect(probed).toEqual([3008, 3009]);
  });

  test("the top of the range has no higher fallback and says so", async () => {
    const { probed, isPortAvailable } = probe([3000]);
    await expect(findAvailableDaemonPort(DAEMON_PORT_RANGE_END, isPortAvailable)).rejects.toThrow(
      `Port ${DAEMON_PORT_RANGE_END} is not available (no higher port`,
    );
    expect(probed).toEqual([DAEMON_PORT_RANGE_END]);
  });

  test("throws the range error only after every port from the default upward is probed", async () => {
    const { probed, isPortAvailable } = probe([]);
    await expect(findAvailableDaemonPort(DEFAULT_DAEMON_PORT, isPortAvailable)).rejects.toThrow(
      `No available ports in range ${DAEMON_PORT_RANGE_START}-${DAEMON_PORT_RANGE_END}`,
    );
    expect(probed).toEqual(
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
