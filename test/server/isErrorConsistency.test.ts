/**
 * Issue #6251: postNotification, setAppPermissions, navigateTo, and
 * setUIState must set `isError: true` whenever their primary operation did
 * not succeed, exactly like tapOn/inputText/sqlQuery already do (#6200).
 * setUIState is the one partial-result exception: it may stay
 * `isError: false` for a genuine partial success (some fields set, others
 * not, #6237), but must flip to `isError: true` when every field fails.
 *
 * Each suite below exercises the exported handler directly through its
 * injected factory seam (mirrors interactionTools.ts's tapAny/dragAndDrop/etc
 * factories) rather than spying on the underlying class's prototype — a
 * process-global prototype spy can leak a mocked result into any other test
 * in the same process that happens to construct the same class (#6251
 * review).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  postNotificationHandler,
  resetPostNotificationFactory,
  setPostNotificationFactory,
} from "../../src/server/notificationTools";
import {
  resetAppPermissionsFactory,
  setAppPermissionsFactory,
  setAppPermissionsHandler,
} from "../../src/server/appTools";
import {
  navigateToHandler,
  resetNavigateToFactory,
  setNavigateToFactory,
} from "../../src/server/navigationTools";
import {
  resetSetUIStateFactory,
  setSetUIStateFactory,
  setUIStateHandler,
} from "../../src/server/formTools";
import type { BootedDevice } from "../../src/models";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 8",
  platform: "android",
};

describe("isError consistency (#6251)", () => {
  describe("postNotification", () => {
    afterEach(() => {
      resetPostNotificationFactory();
    });

    test("receiver-reported failure sets isError: true", async () => {
      setPostNotificationFactory(() => ({
        execute: async () => ({
          success: false,
          supported: true,
          error: "SDK notification receiver reported a failure",
        }),
      }));

      const response = await postNotificationHandler(androidDevice, {
        title: "T",
        body: "B",
        platform: "android",
      });

      expect(response.isError).toBe(true);
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
    });

    test("delivered notification stays isError: false", async () => {
      setPostNotificationFactory(() => ({
        execute: async () => ({
          success: true,
          supported: true,
          method: "sdk",
        }),
      }));

      const response = await postNotificationHandler(androidDevice, {
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
    afterEach(() => {
      resetAppPermissionsFactory();
    });

    test("whole-operation failure (nothing applied) sets isError: true", async () => {
      setAppPermissionsFactory(() => ({
        setPermissions: async () => ({
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
        }),
      }));

      const response = await setAppPermissionsHandler(androidDevice, {
        appId: "com.example.app",
        action: "grant",
        permissions: ["android.permission.CAMERA"],
      });

      expect(response.isError).toBe(true);
    });

    test("genuine partial success (some permissions applied) stays isError: false", async () => {
      setAppPermissionsFactory(() => ({
        setPermissions: async () => ({
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
        }),
      }));

      const response = await setAppPermissionsHandler(androidDevice, {
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
      setAppPermissionsFactory(() => ({
        setPermissions: async () => ({
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
        }),
      }));

      const response = await setAppPermissionsHandler(androidDevice, {
        appId: "com.example.app",
        action: "grant",
        permissions: ["android.permission.CAMERA"],
      });

      expect(response.isError).toBeUndefined();
    });
  });

  describe("navigateTo", () => {
    afterEach(() => {
      resetNavigateToFactory();
    });

    test("failed navigation sets isError: true", async () => {
      setNavigateToFactory(() => ({
        execute: async () => ({
          success: false,
          error: "No path to target screen",
          currentScreen: "Home",
          targetScreen: "Settings",
          stepsExecuted: 0,
        }),
      }));

      const response = await navigateToHandler(androidDevice, {
        targetScreen: "Settings",
        platform: "android",
      });

      expect(response.isError).toBe(true);
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
    });

    test("successful navigation stays isError: false", async () => {
      setNavigateToFactory(() => ({
        execute: async () => ({
          success: true,
          message: "Navigated to Settings",
          currentScreen: "Settings",
          targetScreen: "Settings",
          stepsExecuted: 2,
        }),
      }));

      const response = await navigateToHandler(androidDevice, {
        targetScreen: "Settings",
        platform: "android",
      });

      expect(response.isError).toBeUndefined();
    });
  });

  describe("setUIState", () => {
    afterEach(() => {
      resetSetUIStateFactory();
    });

    test("all fields failing sets isError: true", async () => {
      setSetUIStateFactory(() => ({
        execute: async () => ({
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
        }),
      }));

      const response = await setUIStateHandler(androidDevice, {
        fields: [
          { selector: { text: "Username" }, value: "alice" },
          { selector: { text: "Password" }, value: "secret" },
        ],
      });

      expect(response.isError).toBe(true);
    });

    test("genuine partial success (some fields ok) stays isError: false with per-field status", async () => {
      setSetUIStateFactory(() => ({
        execute: async () => ({
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
        }),
      }));

      const response = await setUIStateHandler(androidDevice, {
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
      setSetUIStateFactory(() => ({
        execute: async () => ({
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
        }),
      }));

      const response = await setUIStateHandler(androidDevice, {
        fields: [{ selector: { text: "Username" }, value: "alice" }],
      });

      expect(response.isError).toBeUndefined();
    });
  });
});
