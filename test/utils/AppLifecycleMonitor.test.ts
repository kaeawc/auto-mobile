import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import {
  AppLifecycleMonitor,
  DefaultAppLifecycleMonitor,
  AppLifecycleEvent,
} from "../../src/utils/AppLifecycleMonitor";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../src/models";
import { logger } from "../../src/utils/logger";

describe("AppLifecycleMonitor", () => {
  let monitor: DefaultAppLifecycleMonitor;
  let fakeAdb: FakeAdbExecutor;
  const testDevice: BootedDevice = {
    deviceId: "test-device-id",
    name: "Test Device",
    platform: "android",
  };

  beforeEach(() => {
    // Create fakes for testing
    fakeAdb = new FakeAdbExecutor();

    // Create a factory that returns our FakeAdbExecutor
    const fakeFactory: AdbClientFactory = {
      create: () => fakeAdb,
    };
    monitor = new DefaultAppLifecycleMonitor(fakeFactory);
  });

  afterEach(async () => {
    // Clean up singleton state
    const trackedPackages = monitor.getTrackedPackages();
    for (const pkg of trackedPackages) {
      await monitor.untrackPackage(testDevice, pkg);
    }

    // Clear all event listeners
    monitor.removeAllListeners();
  });

  describe("singleton pattern", () => {
    test("should return the same instance", () => {
      const instance1 = DefaultAppLifecycleMonitor.getInstance();
      const instance2 = DefaultAppLifecycleMonitor.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("package tracking", () => {
    test("should track packages", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app");
      expect(monitor.getTrackedPackages()).toContain("com.example.app");
    });

    test("should untrack packages", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app");
      await monitor.untrackPackage(testDevice, "com.example.app");
      expect(monitor.getTrackedPackages()).not.toContain("com.example.app");
    });

    test("should track multiple packages", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app1", { stdout: "", stderr: "" });
      fakeAdb.setCommandResponse("shell pidof com.example.app2", { stdout: "", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app1");
      await monitor.trackPackage(testDevice, "com.example.app2");
      expect(monitor.getTrackedPackages()).toHaveLength(2);
      expect(monitor.getTrackedPackages()).toContain("com.example.app1");
      expect(monitor.getTrackedPackages()).toContain("com.example.app2");
    });
  });

  describe("isPackageRunning", () => {
    test("should return true when package is running", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "12345", stderr: "" });

      const isRunning = await monitor.isPackageRunning(testDevice, "com.example.app");
      expect(isRunning).toBe(true);
    });

    test("should return false when package is not running", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "", stderr: "" });

      const isRunning = await monitor.isPackageRunning(testDevice, "com.example.app");
      expect(isRunning).toBe(false);
    });

    test("should return false when pidof command fails", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", {
        stdout: "",
        stderr: "pidof failed",
      });

      const isRunning = await monitor.isPackageRunning(testDevice, "com.example.app");
      expect(isRunning).toBe(false);
    });
  });

  describe("getRunningPackages", () => {
    test("should return empty array initially", () => {
      expect(monitor.getRunningPackages()).toHaveLength(0);
    });

    test("should return running packages after checkForChanges", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "12345", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app");
      await monitor.checkForChanges(testDevice);
      expect(monitor.getRunningPackages()).toContain("com.example.app");
    });
  });

  describe("event emission", () => {
    let launchEvents: AppLifecycleEvent[] = [];
    let terminateEvents: AppLifecycleEvent[] = [];

    beforeEach(() => {
      launchEvents = [];
      terminateEvents = [];

      monitor.addEventListener("launch", async (event) => {
        launchEvents.push(event);
      });

      monitor.addEventListener("terminate", async (event) => {
        terminateEvents.push(event);
      });
    });

    test("should emit launch event for new package", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "12345", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app");

      // Explicitly check for changes
      await monitor.checkForChanges(testDevice);

      expect(launchEvents).toHaveLength(1);
      expect(launchEvents[0].type).toBe("launch");
      expect(launchEvents[0].appId).toBe("com.example.app");
      expect(launchEvents[0].metadata?.detectionMethod).toBe("pidof");
    });

    test("should emit terminate event when package stops", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "12345", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app");

      // Check for changes to establish running state
      await monitor.checkForChanges(testDevice);

      // Clear events from the launch
      launchEvents.length = 0;
      fakeAdb.clearHistory();

      // Simulate package termination
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "", stderr: "" });

      // Check for changes to detect termination
      await monitor.checkForChanges(testDevice);

      expect(fakeAdb.getExecutedCommands()).toContain("shell pidof com.example.app || true");
      expect(terminateEvents).toHaveLength(1);
      expect(terminateEvents[0].type).toBe("terminate");
      expect(terminateEvents[0].appId).toBe("com.example.app");
      expect(terminateEvents[0].metadata?.detectionMethod).toBe("pidof");
    });

    test("should handle multiple packages", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app1", { stdout: "12345", stderr: "" });
      fakeAdb.setCommandResponse("shell pidof com.example.app2", { stdout: "12345", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app1");
      await monitor.trackPackage(testDevice, "com.example.app2");

      // Check for changes to detect launches
      await monitor.checkForChanges(testDevice);

      expect(launchEvents).toHaveLength(2);
      expect(launchEvents.map((e) => e.appId)).toContain("com.example.app1");
      expect(launchEvents.map((e) => e.appId)).toContain("com.example.app2");
    });
  });

  describe("event listener management", () => {
    test("should add and remove event listeners", () => {
      const listener = async () => {};

      monitor.addEventListener("launch", listener);
      monitor.removeEventListener("launch", listener);

      // Listeners are managed by EventEmitter, so we just verify no errors
      expect(monitor.listenerCount("launch")).toBe(0);
    });
  });

  describe("checkForChanges", () => {
    test("should detect package state changes", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app");

      // Initially package is not running
      await monitor.checkForChanges(testDevice);
      expect(monitor.getRunningPackages()).not.toContain("com.example.app");

      // Package starts running
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "12345", stderr: "" });

      await monitor.checkForChanges(testDevice);
      expect(monitor.getRunningPackages()).toContain("com.example.app");
    });
  });

  describe("error handling", () => {
    test("preserves running package state and suppresses terminate event when pidof probe fails", async () => {
      const terminateEvents: AppLifecycleEvent[] = [];
      const probeError = new Error("adb transport closed");
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        monitor.addEventListener("terminate", async (event) => {
          terminateEvents.push(event);
        });

        fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "12345", stderr: "" });
        await monitor.trackPackage(testDevice, "com.example.app");
        expect(monitor.getRunningPackages()).toEqual(["com.example.app"]);

        fakeAdb.setCommandError("shell pidof com.example.app", probeError);
        await monitor.checkForChanges(testDevice);

        expect(monitor.getRunningPackages()).toEqual(["com.example.app"]);
        expect(terminateEvents).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain(
          "Failed to check whether com.example.app is running",
        );
        expect(warnSpy.mock.calls[0]?.[1]).toBe(probeError);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("should handle event emission errors gracefully", async () => {
      fakeAdb.setCommandResponse("shell pidof com.example.app", { stdout: "12345", stderr: "" });

      await monitor.trackPackage(testDevice, "com.example.app");

      // Add listener that throws
      monitor.addEventListener("launch", async () => {
        throw new Error("Event handler error");
      });

      // Should not throw
      await monitor.checkForChanges(testDevice);
    });
  });

  describe("type safety", () => {
    test("instance exposes both interface and class-specific methods", () => {
      const instance = monitor;

      // Interface methods are accessible
      expect(typeof instance.trackPackage).toBe("function");
      expect(typeof instance.untrackPackage).toBe("function");
      expect(typeof instance.getTrackedPackages).toBe("function");
      expect(typeof instance.isPackageRunning).toBe("function");
      expect(typeof instance.getRunningPackages).toBe("function");
      expect(typeof instance.checkForChanges).toBe("function");

      // Event listener methods (from the interface) are accessible
      expect(typeof instance.addEventListener).toBe("function");
      expect(typeof instance.removeEventListener).toBe("function");
      expect(typeof instance.removeAllListeners).toBe("function");
      expect(typeof instance.listenerCount).toBe("function");

      // Verify it satisfies the interface type
      const asInterface: AppLifecycleMonitor = instance;
      expect(typeof asInterface.addEventListener).toBe("function");
      expect(typeof asInterface.removeEventListener).toBe("function");
      expect(typeof asInterface.removeAllListeners).toBe("function");
      expect(typeof asInterface.listenerCount).toBe("function");
    });
  });
});
