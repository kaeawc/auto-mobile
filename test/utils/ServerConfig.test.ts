import { describe, expect, test, beforeEach } from "bun:test";
import { serverConfig } from "../../src/utils/ServerConfig";

describe("ServerConfig", () => {
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
