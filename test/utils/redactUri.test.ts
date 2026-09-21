import { describe, expect, test } from "bun:test";
import { redactUri } from "../../src/utils/redactUri";

describe("redactUri", () => {
  test("keeps only the scheme and host for a credential-bearing custom-scheme deep link", () => {
    const rawUrl = "myapp://user:secretpass@host.example/path/x?token=abc123#frag";
    const redacted = redactUri(rawUrl);

    expect(redacted).toBe("myapp://host.example/<redacted>");
    expect(redacted).not.toContain("secretpass");
    expect(redacted).not.toContain("token=abc123");
    expect(redacted).not.toContain("/path/x");
  });

  test("keeps only the scheme and host for an HTTPS URL with credentials and query secrets", () => {
    const rawUrl = "https://user:pw@example.com/reset?token=abc123";
    const redacted = redactUri(rawUrl);

    expect(redacted).toBe("https://example.com/<redacted>");
    expect(redacted).not.toContain("user");
    expect(redacted).not.toContain("pw");
    expect(redacted).not.toContain("token=abc123");
  });

  test("keeps only the scheme for an opaque custom-scheme URI", () => {
    const redacted = redactUri("myapp:action?token=abc123");

    expect(redacted).toBe("myapp:<redacted>");
    expect(redacted).not.toContain("action");
    expect(redacted).not.toContain("token=abc123");
  });

  test("safely masks malformed input without throwing", () => {
    const rawUrl = "not a valid URI token=abc123";
    const redacted = redactUri(rawUrl);

    expect(redacted).toBe("<redacted>");
    expect(redacted).not.toContain("token=abc123");
  });
});
