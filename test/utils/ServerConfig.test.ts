import { describe, expect, test, beforeEach } from "bun:test";
import { serverConfig } from "../../src/utils/ServerConfig";

describe("ServerConfig", () => {
  describe("tool output artifacts", () => {
    beforeEach(() => {
      serverConfig.setToolOutputsDir(undefined);
    });

    test("defaults to artifact mode disabled", () => {
      expect(serverConfig.getToolOutputsDir()).toBeUndefined();
      expect(serverConfig.isToolOutputArtifactModeEnabled()).toBe(false);
    });

    test("enables artifact mode when a directory is configured", () => {
      serverConfig.setToolOutputsDir("/tmp/auto-mobile-artifacts");

      expect(serverConfig.getToolOutputsDir()).toBe("/tmp/auto-mobile-artifacts");
      expect(serverConfig.isToolOutputArtifactModeEnabled()).toBe(true);
    });

    test("copies the configured directory value out of config", () => {
      const dir = "/tmp/auto-mobile-artifacts";
      serverConfig.setToolOutputsDir(dir);
      const configured = serverConfig.getToolOutputsDir();

      expect(configured).toBe(dir);
      serverConfig.setToolOutputsDir(undefined);
      expect(configured).toBe(dir);
    });
  });

  describe("dismissKeyboardAfterInput", () => {
    beforeEach(() => {
      serverConfig.setDismissKeyboardAfterInputEnabled(false);
    });

    test("defaults to false", () => {
      expect(serverConfig.isDismissKeyboardAfterInputEnabled()).toBe(false);
    });

    test("returns true after being enabled", () => {
      serverConfig.setDismissKeyboardAfterInputEnabled(true);
      expect(serverConfig.isDismissKeyboardAfterInputEnabled()).toBe(true);
    });

    test("can be toggled back to false", () => {
      serverConfig.setDismissKeyboardAfterInputEnabled(true);
      serverConfig.setDismissKeyboardAfterInputEnabled(false);
      expect(serverConfig.isDismissKeyboardAfterInputEnabled()).toBe(false);
    });
  });
});
