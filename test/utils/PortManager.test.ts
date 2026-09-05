import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  computeConfiguredScanEnd,
  IOS_CTRL_PROXY_RESERVED_PORTS,
  PortManager,
  type PortAvailabilityChecker,
} from "../../src/utils/PortManager";

class FakePortAvailabilityChecker implements PortAvailabilityChecker {
  public readonly checkedPorts: number[] = [];

  public constructor(private readonly unavailablePorts: Set<number> = new Set()) {}

  public isPortAvailable(port: number): boolean {
    this.checkedPorts.push(port);
    return !this.unavailablePorts.has(port);
  }
}

function expectedAllocatedPort(index: number): number {
  return 8765 + index;
}

function expectedIosAllocatedPort(index: number): number {
  const port = expectedAllocatedPort(index);
  return port >= 8766 ? port + 1 : port;
}

describe("PortManager", () => {
  beforeEach(() => {
    PortManager.setPortAvailabilityCheckerForTesting(new FakePortAvailabilityChecker());
    // Reset before each test to ensure clean state (other tests may allocate ports)
    PortManager.reset();
  });

  afterEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("should allocate unique ports for different devices", () => {
    const port1 = PortManager.allocate("device-1");
    const port2 = PortManager.allocate("device-2");
    const port3 = PortManager.allocate("device-3");

    expect(port1).toBe(8765);
    expect(port2).toBe(8766);
    expect(port3).toBe(8767);
  });

  test("should reserve the iOS SDK hierarchy server port when requested", () => {
    const port1 = PortManager.allocate("device-1", {
      reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
    });
    const port2 = PortManager.allocate("device-2", {
      reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
    });

    expect(port1).toBe(8765);
    expect(port2).toBe(8767);
    expect([...PortManager.getAllocations().values()]).not.toContain(8766);
  });

  test("should skip ports unavailable on the host OS", () => {
    const checker = new FakePortAvailabilityChecker(new Set([8765, 8766]));
    PortManager.setPortAvailabilityCheckerForTesting(checker);

    const port = PortManager.allocate("device-1");

    expect(port).toBe(8767);
    expect(checker.checkedPorts).toEqual([8765, 8766, 8767]);
  });

  test("should combine scoped reserved ports with unavailable host ports", () => {
    const checker = new FakePortAvailabilityChecker(new Set([8765, 8767]));
    PortManager.setPortAvailabilityCheckerForTesting(checker);

    const port = PortManager.allocate("device-1", { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS });

    expect(port).toBe(8768);
    expect(checker.checkedPorts).toEqual([8765, 8767, 8768]);
  });

  test("should return same port for same device", () => {
    const port1 = PortManager.allocate("device-1");
    const port2 = PortManager.allocate("device-1");
    const port3 = PortManager.allocate("device-1");

    expect(port1).toBe(port2);
    expect(port2).toBe(port3);
  });

  test("should release port and allow reallocation", () => {
    const port1 = PortManager.allocate("device-1");
    expect(port1).toBe(8765);

    PortManager.release("device-1");
    expect(PortManager.getPort("device-1")).toBeUndefined();

    // Device-2 should get the released port
    const port2 = PortManager.allocate("device-2");
    expect(port2).toBe(8765);
  });

  test("should reserve a known port for a device", () => {
    PortManager.allocate("device-1");

    PortManager.reserve("device-1", 8767);

    expect(PortManager.getPort("device-1")).toBe(8767);
    expect(PortManager.allocate("device-2")).toBe(8765);
  });

  test("should reject reserving a port allocated to another device", () => {
    PortManager.allocate("device-1");

    expect(() => PortManager.reserve("device-2", 8765)).toThrow(
      "Port 8765 is already allocated to device device-1",
    );
  });

  test("should reuse released ports in order", () => {
    PortManager.allocate("device-1"); // 8765
    PortManager.allocate("device-2"); // 8766
    PortManager.allocate("device-3"); // 8767

    PortManager.release("device-2"); // frees 8766

    // New device should get the first available port (8766)
    const newPort = PortManager.allocate("device-4");
    expect(newPort).toBe(8766);
  });

  test("should track allocated count", () => {
    expect(PortManager.getAllocatedCount()).toBe(0);

    PortManager.allocate("device-1");
    expect(PortManager.getAllocatedCount()).toBe(1);

    PortManager.allocate("device-2");
    expect(PortManager.getAllocatedCount()).toBe(2);

    PortManager.release("device-1");
    expect(PortManager.getAllocatedCount()).toBe(1);
  });

  test("should reset all allocations", () => {
    PortManager.allocate("device-1");
    PortManager.allocate("device-2");
    PortManager.allocate("device-3");

    expect(PortManager.getAllocatedCount()).toBe(3);

    PortManager.reset();

    expect(PortManager.getAllocatedCount()).toBe(0);
    expect(PortManager.getPort("device-1")).toBeUndefined();
  });

  test("should get WebSocket URL with allocated port", () => {
    const url1 = PortManager.getWebSocketUrl("device-1");
    const url2 = PortManager.getWebSocketUrl("device-2");

    expect(url1).toBe("ws://127.0.0.1:8765/ws");
    expect(url2).toBe("ws://127.0.0.1:8766/ws");
  });

  test("should return allocations map", () => {
    PortManager.allocate("device-1");
    PortManager.allocate("device-2");

    const allocations = PortManager.getAllocations();

    expect(allocations.size).toBe(2);
    expect(allocations.get("device-1")).toBe(8765);
    expect(allocations.get("device-2")).toBe(8766);
  });

  test("should expose base port and device port constants", () => {
    expect(PortManager.getBasePort()).toBe(8765);
    expect(PortManager.getMaxDevices()).toBe(100);
    expect(PortManager.DEVICE_PORT).toBe(8765);
  });

  test("should handle release of non-existent device gracefully", () => {
    // Should not throw
    PortManager.release("non-existent-device");
    expect(PortManager.getAllocatedCount()).toBe(0);
  });

  test("should support many devices up to MAX_DEVICES", () => {
    // Allocate 50 devices (well under 100 limit)
    for (let i = 0; i < 50; i++) {
      const port = PortManager.allocate(`device-${i}`);
      expect(port).toBe(expectedAllocatedPort(i));
    }

    expect(PortManager.getAllocatedCount()).toBe(50);
  });

  test("should support many iOS devices while skipping reserved ports", () => {
    for (let i = 0; i < 50; i++) {
      const port = PortManager.allocate(`ios-device-${i}`, {
        reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
      });
      expect(port).toBe(expectedIosAllocatedPort(i));
    }

    expect(PortManager.getAllocatedCount()).toBe(50);
  });

  test("should support 100 iOS devices while skipping reserved ports", () => {
    const ports: number[] = [];

    for (let i = 0; i < PortManager.getMaxDevices(); i++) {
      ports.push(
        PortManager.allocate(`ios-device-${i}`, { reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS }),
      );
    }

    expect(ports).toHaveLength(100);
    expect(new Set(ports).size).toBe(100);
    expect(ports).not.toContain(8766);
    expect(ports[0]).toBe(8765);
    expect(ports[99]).toBe(8865);
  });

  test("should support 100 mixed Android and iOS devices when the default port is already in use", () => {
    const checker = new FakePortAvailabilityChecker(new Set([8765]));
    PortManager.setPortAvailabilityCheckerForTesting(checker);
    const ports: number[] = [];

    for (let i = 0; i < PortManager.getMaxDevices(); i++) {
      const reservedPorts = i % 2 === 0 ? IOS_CTRL_PROXY_RESERVED_PORTS : undefined;
      ports.push(PortManager.allocate(`device-${i}`, { reservedPorts }));
    }

    expect(ports).toHaveLength(100);
    expect(new Set(ports).size).toBe(100);
    expect(ports).not.toContain(8765);
    expect(ports[0]).toBe(8767);
    expect(ports[99]).toBe(8865);
  });
});

describe("BunPortAvailabilityChecker (real checker, fake Bun.listen)", () => {
  const originalListen = Bun.listen;

  function fakeErrno(code: string): Error {
    const error = new Error(`Failed to listen: ${code}`);
    (error as { code?: string }).code = code;
    return error;
  }

  function installFakeBunListen(behaviors: Record<string, "ok" | Error>): void {
    (Bun as { listen: typeof Bun.listen }).listen = ((options: { hostname: string }) => {
      const behavior = behaviors[options.hostname];
      if (behavior instanceof Error) {
        throw behavior;
      }
      return { stop() {} };
    }) as typeof Bun.listen;
  }

  beforeEach(() => {
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  afterEach(() => {
    (Bun as { listen: typeof Bun.listen }).listen = originalListen;
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("reports the port available when ::1 fails with EADDRNOTAVAIL but 127.0.0.1 succeeds", () => {
    installFakeBunListen({
      "127.0.0.1": "ok",
      "::1": fakeErrno("EADDRNOTAVAIL"),
    });

    expect(PortManager.isPortAvailable(9999)).toBe(true);
  });

  test("reports the port busy when ::1 fails with EADDRINUSE even though 127.0.0.1 succeeds", () => {
    installFakeBunListen({
      "127.0.0.1": "ok",
      "::1": fakeErrno("EADDRINUSE"),
    });

    expect(PortManager.isPortAvailable(9999)).toBe(false);
  });

  test("reports the port busy when 127.0.0.1 fails with EADDRINUSE", () => {
    installFakeBunListen({
      "127.0.0.1": fakeErrno("EADDRINUSE"),
      "::1": "ok",
    });

    expect(PortManager.isPortAvailable(9999)).toBe(false);
  });

  test("reports the port available when both loopback families succeed", () => {
    installFakeBunListen({
      "127.0.0.1": "ok",
      "::1": "ok",
    });

    expect(PortManager.isPortAvailable(9999)).toBe(true);
  });

  test("reports the port busy when 127.0.0.1 fails with EACCES", () => {
    installFakeBunListen({
      "127.0.0.1": fakeErrno("EACCES"),
      "::1": "ok",
    });

    expect(PortManager.isPortAvailable(9999)).toBe(false);
  });
});

describe("computeConfiguredScanEnd (AUTOMOBILE_PORT_RANGE_END scan bound, #6119)", () => {
  test("bounds the scan at the configured range end", () => {
    expect(computeConfiguredScanEnd(9000, "9001", undefined)).toBe(9001);
  });

  test("bounds the scan from a configured range size", () => {
    expect(computeConfiguredScanEnd(9000, undefined, "2")).toBe(9001);
  });

  test("leaves the scan unbounded when neither env var is set", () => {
    expect(computeConfiguredScanEnd(8765, undefined, undefined)).toBeUndefined();
  });

  test("leaves the scan unbounded when the range end is below the base port", () => {
    expect(computeConfiguredScanEnd(9000, "8999", undefined)).toBeUndefined();
  });

  test("leaves the scan unbounded when the range end is not a number", () => {
    expect(computeConfiguredScanEnd(9000, "not-a-number", undefined)).toBeUndefined();
  });

  test("leaves the scan unbounded when the range size is zero or negative", () => {
    expect(computeConfiguredScanEnd(9000, undefined, "0")).toBeUndefined();
    expect(computeConfiguredScanEnd(9000, undefined, "-5")).toBeUndefined();
  });

  test("prefers range end over range size when both are set", () => {
    expect(computeConfiguredScanEnd(9000, "9001", "50")).toBe(9001);
  });
});
