/**
 * Issue #6251: postNotification, setAppPermissions, navigateTo, and
 * setUIState must set `isError: true` whenever their primary operation did
 * not succeed, exactly like tapOn/inputText/sqlQuery already do (#6200).
 * setUIState is the one partial-result exception: it may stay
 * `isError: false` for a genuine partial success (some fields set, others
 * not, #6237), but must flip to `isError: true` when every field fails.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { registerNotificationTools } from "../../src/server/notificationTools";
import { PostNotification } from "../../src/features/utility/PostNotification";
import { registerAppTools } from "../../src/server/appTools";
import { AppPermissions } from "../../src/features/action/AppPermissions";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { NavigateTo } from "../../src/features/navigation/NavigateTo";
import { registerFormTools } from "../../src/server/formTools";
import { SetUIState } from "../../src/features/action/SetUIState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";

type DeviceAwareHandler = (device: BootedDevice, args: any) => Promise<any>;

function getHandler(toolName: string): DeviceAwareHandler {
  const tools = (
    ToolRegistry as unknown as {
      tools: Map<string, { deviceAwareHandler?: DeviceAwareHandler }>;
    }
  ).tools;
  const handler = tools.get(toolName)?.deviceAwareHandler;
  if (!handler) {
    throw new Error(`${toolName} was not registered as device-aware`);
  }
  return handler;
}

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 8",
  platform: "android",
};

describe("isError consistency (#6251)", () => {
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  describe("postNotification", () => {
    let executeSpy: Mock<typeof PostNotification.prototype.execute>;

    beforeEach(() => {
      ToolRegistry.clearTools();
      registerNotificationTools();
      executeSpy = spyOn(PostNotification.prototype, "execute") as unknown as Mock<
        typeof PostNotification.prototype.execute
      >;
    });

    afterEach(() => {
      executeSpy.mockRestore();
    });

    test("receiver-reported failure sets isError: true", async () => {
      executeSpy.mockResolvedValue({
        success: false,
        supported: true,
        error: "SDK notification receiver reported a failure",
      });

      const response = await getHandler("postNotification")(androidDevice, {
        title: "T",
        body: "B",
        platform: "android",
      });

      expect(response.isError).toBe(true);
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
    });

    test("delivered notification stays isError: false", async () => {
      executeSpy.mockResolvedValue({
        success: true,
        supported: true,
        method: "sdk",
      });

      const response = await getHandler("postNotification")(androidDevice, {
        title: "T",
        body: "B",
        platform: "android",
      });

      expect(response.isError).toBeUndefined();
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(true);
    });
  });

  describe("setAppPermissions", () => {
    let setPermissionsSpy: Mock<typeof AppPermissions.prototype.setPermissions>;

    beforeEach(() => {
      ToolRegistry.clearTools();
      registerAppTools();
      setPermissionsSpy = spyOn(AppPermissions.prototype, "setPermissions") as unknown as Mock<
        typeof AppPermissions.prototype.setPermissions
      >;
    });

    afterEach(() => {
      setPermissionsSpy.mockRestore();
    });

    test("whole-operation failure (nothing applied) sets isError: true", async () => {
      setPermissionsSpy.mockResolvedValue({
        success: false,
        appId: "com.example.app",
        deviceId: androidDevice.deviceId,
        platform: "android",
        action: "grant",
        changedCount: 0,
        failedCount: 1,
        operations: [
          {
            operationId: "android_runtime_permissions:grant",
            success: false,
            changedCount: 0,
            failedCount: 1,
            error: "Failed step(s)",
          },
        ],
        error: "Failed step(s)",
      });

      const response = await getHandler("setAppPermissions")(androidDevice, {
        appId: "com.example.app",
        action: "grant",
        permissions: ["android.permission.CAMERA"],
      });

      expect(response.isError).toBe(true);
    });

    test("genuine partial success (some permissions applied) stays isError: false", async () => {
      setPermissionsSpy.mockResolvedValue({
        success: false,
        appId: "com.example.app",
        deviceId: androidDevice.deviceId,
        platform: "android",
        action: "grant",
        changedCount: 1,
        failedCount: 1,
        operations: [
          {
            operationId: "android_runtime_permissions:grant",
            success: true,
            changedCount: 1,
            failedCount: 0,
          },
          {
            operationId: "android_notifications_enabled",
            success: false,
            changedCount: 0,
            failedCount: 1,
            error: "Failed to set notifications enabled",
          },
        ],
        error: "Failed to set notifications enabled",
      });

      const response = await getHandler("setAppPermissions")(androidDevice, {
        appId: "com.example.app",
        action: "grant",
        permissions: ["android.permission.CAMERA"],
        notificationsEnabled: true,
      });

      expect(response.isError).toBeUndefined();
      const payload = JSON.parse(response.content[0].text);
      expect(payload.changedCount).toBe(1);
    });

    test("full success stays isError: false", async () => {
      setPermissionsSpy.mockResolvedValue({
        success: true,
        appId: "com.example.app",
        deviceId: androidDevice.deviceId,
        platform: "android",
        action: "grant",
        changedCount: 1,
        failedCount: 0,
        operations: [
          {
            operationId: "android_runtime_permissions:grant",
            success: true,
            changedCount: 1,
            failedCount: 0,
          },
        ],
      });

      const response = await getHandler("setAppPermissions")(androidDevice, {
        appId: "com.example.app",
        action: "grant",
        permissions: ["android.permission.CAMERA"],
      });

      expect(response.isError).toBeUndefined();
    });
  });

  describe("navigateTo", () => {
    let executeSpy: Mock<typeof NavigateTo.prototype.execute>;

    beforeEach(() => {
      ToolRegistry.clearTools();
      registerNavigationTools();
      executeSpy = spyOn(NavigateTo.prototype, "execute") as unknown as Mock<
        typeof NavigateTo.prototype.execute
      >;
    });

    afterEach(() => {
      executeSpy.mockRestore();
    });

    test("failed navigation sets isError: true", async () => {
      executeSpy.mockResolvedValue({
        success: false,
        error: "No path to target screen",
        currentScreen: "Home",
        targetScreen: "Settings",
        stepsExecuted: 0,
      });

      const response = await getHandler("navigateTo")(androidDevice, {
        targetScreen: "Settings",
        platform: "android",
      });

      expect(response.isError).toBe(true);
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
    });

    test("successful navigation stays isError: false", async () => {
      executeSpy.mockResolvedValue({
        success: true,
        message: "Navigated to Settings",
        currentScreen: "Settings",
        targetScreen: "Settings",
        stepsExecuted: 2,
      });

      const response = await getHandler("navigateTo")(androidDevice, {
        targetScreen: "Settings",
        platform: "android",
      });

      expect(response.isError).toBeUndefined();
    });
  });

  describe("setUIState", () => {
    let executeSpy: Mock<typeof SetUIState.prototype.execute>;

    beforeEach(() => {
      ToolRegistry.clearTools();
      registerFormTools();
      executeSpy = spyOn(SetUIState.prototype, "execute") as unknown as Mock<
        typeof SetUIState.prototype.execute
      >;
    });

    afterEach(() => {
      executeSpy.mockRestore();
    });

    test("all fields failing sets isError: true", async () => {
      executeSpy.mockResolvedValue({
        success: false,
        fields: [
          {
            selector: { text: "Username" },
            success: false,
            attempts: 3,
            error: "Element not found",
          },
          {
            selector: { text: "Password" },
            success: false,
            attempts: 3,
            error: "Element not found",
          },
        ],
        totalAttempts: 6,
        error: "Some fields could not be set",
      });

      const response = await getHandler("setUIState")(androidDevice, {
        fields: [
          { selector: { text: "Username" }, value: "alice" },
          { selector: { text: "Password" }, value: "secret" },
        ],
      });

      expect(response.isError).toBe(true);
    });

    test("genuine partial success (some fields ok) stays isError: false with per-field status", async () => {
      executeSpy.mockResolvedValue({
        success: false,
        fields: [
          {
            selector: { text: "Username" },
            success: true,
            attempts: 1,
            verified: true,
          },
          {
            selector: { text: "Password" },
            success: false,
            attempts: 3,
            error: "Element not found",
          },
        ],
        totalAttempts: 4,
        error: "Some fields could not be set",
      });

      const response = await getHandler("setUIState")(androidDevice, {
        fields: [
          { selector: { text: "Username" }, value: "alice" },
          { selector: { text: "Password" }, value: "secret" },
        ],
      });

      expect(response.isError).toBeUndefined();
      const payload = response.structuredContent;
      expect(payload.success).toBe(false);
      expect(payload.fields).toHaveLength(2);
      expect(payload.fields[0].success).toBe(true);
      expect(payload.fields[1].success).toBe(false);
    });

    test("full success stays isError: false", async () => {
      executeSpy.mockResolvedValue({
        success: true,
        fields: [
          {
            selector: { text: "Username" },
            success: true,
            attempts: 1,
            verified: true,
          },
        ],
        totalAttempts: 1,
      });

      const response = await getHandler("setUIState")(androidDevice, {
        fields: [{ selector: { text: "Username" }, value: "alice" }],
      });

      expect(response.isError).toBeUndefined();
    });
  });
});
