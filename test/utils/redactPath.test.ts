import { describe, it, expect } from "bun:test";
import { redactHomeDir } from "../../src/utils/redactPath";

describe("redactHomeDir", () => {
  it("replaces a leading home-directory prefix with ~", () => {
    expect(redactHomeDir("/Users/alice/.auto-mobile/video-archive/case-1.mp4", "/Users/alice")).toBe(
      "~/.auto-mobile/video-archive/case-1.mp4"
    );
  });

  it("leaves a path without the home prefix unchanged", () => {
    expect(redactHomeDir("/var/tmp/case-1.mp4", "/Users/alice")).toBe("/var/tmp/case-1.mp4");
  });

  it("does not redact when the home directory is empty", () => {
    expect(redactHomeDir("/Users/alice/x", "")).toBe("/Users/alice/x");
  });

  it("only redacts the leading occurrence of the home prefix", () => {
    expect(redactHomeDir("/home/bob/a/home/bob/b", "/home/bob")).toBe("~/a/home/bob/b");
  });
});
