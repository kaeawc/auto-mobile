import { expect, describe, test } from "bun:test";
import {
  CMDLINE_TOOLS_DOWNLOAD,
} from "../../../src/utils/android-cmdline-tools/install";

describe("Android Command Line Tools - Installation", () => {
  describe("CMDLINE_TOOLS_DOWNLOAD", () => {
    test("should have correct download information", () => {
      expect(CMDLINE_TOOLS_DOWNLOAD.version).toBe("13114758");
      expect(CMDLINE_TOOLS_DOWNLOAD.baseUrl).toBe("https://dl.google.com/android/repository");
      expect(CMDLINE_TOOLS_DOWNLOAD.platforms).toHaveProperty("darwin");
      expect(CMDLINE_TOOLS_DOWNLOAD.platforms).toHaveProperty("linux");
      expect(CMDLINE_TOOLS_DOWNLOAD.platforms).toHaveProperty("win32");

      // Check platform-specific info
      expect(CMDLINE_TOOLS_DOWNLOAD.platforms.darwin.filename).toContain("mac");
      expect(CMDLINE_TOOLS_DOWNLOAD.platforms.linux.filename).toContain("linux");
      expect(CMDLINE_TOOLS_DOWNLOAD.platforms.win32.filename).toContain("win");

      // Check checksums are present
      Object.values(CMDLINE_TOOLS_DOWNLOAD.platforms).forEach(platform => {
        expect(typeof platform.checksum).toBe("string");
        expect(platform.checksum.length).toBe(64); // SHA-256 hex
      });
    });
  });
});
