import { describe, expect, test } from "bun:test";
import { redactToolSecrets, TOOL_SECRET_PLACEHOLDER } from "../../src/utils/redactToolSecrets";
import {
  redactPlanYamlTypedText,
  redactTypedTextArguments,
} from "../../src/utils/redactTypedTextArguments";

const SECRET = "hunter2-store";
const installArgs = () => ({
  artifactPath: "/apps/app.aab",
  bundle: {
    modules: ["feature"],
    keystore: { path: "/k.jks", alias: "release", storePassword: SECRET, keyPassword: SECRET },
  },
  grantAllPermissions: true,
});

describe("redactToolSecrets", () => {
  test("replaces installApp keystore passwords and keeps everything else", () => {
    const args = installArgs();
    expect(redactToolSecrets("installApp", args)).toEqual({
      artifactPath: "/apps/app.aab",
      bundle: {
        modules: ["feature"],
        keystore: {
          path: "/k.jks",
          alias: "release",
          storePassword: TOOL_SECRET_PLACEHOLDER,
          keyPassword: TOOL_SECRET_PLACEHOLDER,
        },
      },
      grantAllPermissions: true,
    });
    // The caller's arguments are not mutated.
    expect(args.bundle.keystore.storePassword).toBe(SECRET);
  });

  test("returns the same reference when there is nothing to redact", () => {
    const plain = { artifactPath: "/apps/app.apk" };
    const noPasswords = { artifactPath: "/apps/app.aab", bundle: { keystore: { path: "/k" } } };
    expect(redactToolSecrets("installApp", plain)).toBe(plain);
    expect(redactToolSecrets("installApp", noPasswords)).toBe(noPasswords);
    const otherTool = installArgs();
    expect(redactToolSecrets("tapOn", otherTool)).toBe(otherTool);
    expect(redactToolSecrets(undefined, "text")).toBe("text");
  });

  test("the generic log redaction covers installApp, inline and inside a plan", () => {
    expect(JSON.stringify(redactTypedTextArguments("installApp", installArgs()))).not.toContain(
      SECRET,
    );
    const plan = [
      "name: install",
      "steps:",
      "  - tool: installApp",
      "    artifactPath: /apps/app.aab",
      "    bundle:",
      "      keystore:",
      "        path: /k.jks",
      "        alias: release",
      `        storePassword: ${SECRET}`,
    ].join("\n");
    const redacted = redactPlanYamlTypedText(plan);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain(TOOL_SECRET_PLACEHOLDER);
  });
});
