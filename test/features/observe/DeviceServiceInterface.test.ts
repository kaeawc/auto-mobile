/**
 * Interface compliance tests for DeviceService implementations.
 *
 * These tests verify that both AndroidCtrlProxyClient and
 * IOSCtrlProxyClient properly implement the DeviceService interface.
 *
 * The tests focus on:
 * 1. Type compatibility - instances can be assigned to interface type
 * 2. Method presence - all required interface methods exist
 * 3. Connection lifecycle - shared connection management works correctly
 */

import { describe, expect, test } from "bun:test";
import type {
  DeviceService,
  AndroidDeviceService,
} from "../../../src/features/observe/DeviceService";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { BootedDevice } from "../../../src/models";
import {
  createSuccessWebSocketFactory,
  createInstantFailureWebSocketFactory,
} from "../../fakes/FakeWebSocket";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("DeviceService Interface Compliance", () => {
  // ===========================================================================
  // Type Compliance Tests (compile-time verification)
  // ===========================================================================

  describe("Type Compliance", () => {
    test("AndroidCtrlProxyClient is assignable to DeviceService and reports disconnected before connecting", () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });

      const testDevice: BootedDevice = {
        deviceId: "test-android-device",
        platform: "android",
        isEmulator: true,
        name: "Test Android Device",
      };

      AndroidCtrlProxyClient.resetInstances();
      // Pass FakeAdbExecutor directly since it implements AdbExecutor interface
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(),
        fakeTimer,
      );

      // The assignment is the interface-conformance check (tsc fails the build if the class stops
      // implementing DeviceService) — no runtime `typeof method === "function"` echo of what the
      // compiler already proves. The behavioral assertion exercises a DeviceService method through
      // the interface reference: a freshly created client reports itself disconnected.
      const deviceService: DeviceService = client;
      expect(deviceService.isConnected()).toBe(false);

      void client.close();
    });

    test("IOSCtrlProxyClient is assignable to DeviceService and reports disconnected before connecting", () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const testDevice: BootedDevice = {
        deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
        platform: "ios",
        name: "Test iOS Device",
      };

      IOSCtrlProxyClient.resetInstances();
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
      );

      const deviceService: DeviceService = client;
      expect(deviceService.isConnected()).toBe(false);

      void client.close();
    });

    test("AndroidCtrlProxyClient is assignable to AndroidDeviceService and reports disconnected before connecting", () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });

      const testDevice: BootedDevice = {
        deviceId: "test-android-device",
        platform: "android",
        isEmulator: true,
        name: "Test Android Device",
      };

      AndroidCtrlProxyClient.resetInstances();
      // Pass FakeAdbExecutor directly since it implements AdbExecutor interface
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(),
        fakeTimer,
      );

      // Assignment proves AndroidDeviceService conformance at compile time; the assertion exercises
      // the interface reference's base behavior.
      const androidService: AndroidDeviceService = client;
      expect(androidService.isConnected()).toBe(false);

      void client.close();
    });

    test("IOSCtrlProxyClient exposes Apple-specific control methods", () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const testDevice: BootedDevice = {
        deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
        platform: "ios",
        name: "Test iOS Device",
      };

      IOSCtrlProxyClient.resetInstances();
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
      );

      // Pin the Apple-specific control surface at compile time: dropping any of these
      // from IOSCtrlProxyClient fails tsc HERE, which is what this test's name guards.
      const appleControls: {
        requestLaunchApp: typeof client.requestLaunchApp;
        requestPressHome: typeof client.requestPressHome;
        requestPressButton: typeof client.requestPressButton;
      } = {
        requestLaunchApp: client.requestLaunchApp,
        requestPressHome: client.requestPressHome,
        requestPressButton: client.requestPressButton,
      };
      void appleControls;
      // The behavioral assertion exercises the client's initial disconnected state.
      expect(client.isConnected()).toBe(false);

      void client.close();
    });
  });

  // ===========================================================================
  // Connection State Tests (shared behavior via base class)
  // ===========================================================================

  describe("Connection State (Android)", () => {
    test("isConnected returns false before connection", () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });

      const testDevice: BootedDevice = {
        deviceId: "test-android-device",
        platform: "android",
        isEmulator: true,
        name: "Test Android Device",
      };

      AndroidCtrlProxyClient.resetInstances();
      // Pass FakeAdbExecutor directly since it implements AdbExecutor interface
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
      );

      expect(client.isConnected()).toBe(false);
      void client.close();
    });

    test("ensureConnected returns false on connection failure", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });

      const testDevice: BootedDevice = {
        deviceId: "test-android-device",
        platform: "android",
        isEmulator: true,
        name: "Test Android Device",
      };

      AndroidCtrlProxyClient.resetInstances();
      // Pass FakeAdbExecutor directly since it implements AdbExecutor interface
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
      );

      const connected = await client.ensureConnected();
      expect(connected).toBe(false);
      expect(client.isConnected()).toBe(false);

      await client.close();
    });
  });

  describe("Connection State (iOS)", () => {
    test("isConnected returns false before connection", () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const testDevice: BootedDevice = {
        deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
        platform: "ios",
        name: "Test iOS Device",
      };

      IOSCtrlProxyClient.resetInstances();
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
      );

      expect(client.isConnected()).toBe(false);
      void client.close();
    });

    test("ensureConnected returns false on connection failure", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const testDevice: BootedDevice = {
        deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
        platform: "ios",
        name: "Test iOS Device",
      };

      IOSCtrlProxyClient.resetInstances();
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        8765,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
      );

      const connected = await client.ensureConnected();
      expect(connected).toBe(false);
      expect(client.isConnected()).toBe(false);

      await client.close();
    });
  });
});
