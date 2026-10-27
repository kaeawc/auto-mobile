import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  BundletoolNotFoundError,
  DefaultBundletoolLocator,
  requireBundletool,
} from "../../../src/utils/android-cmdline-tools/BundletoolLocator";
import { FakeBundletoolLocator } from "../../fakes/FakeBundletoolLocator";
import { FakeSystemDetection } from "../../fakes/FakeSystemDetection";

const JAR = "/opt/bundletool/bundletool-all-1.18.1.jar";

function locator(env: NodeJS.ProcessEnv, setup: (system: FakeSystemDetection) => void = () => {}) {
  const system = new FakeSystemDetection();
  setup(system);
  return new DefaultBundletoolLocator(system, env);
}

describe("DefaultBundletoolLocator", () => {
  test("a configured jar runs with JAVA_HOME's java", async () => {
    const lookup = await locator(
      { AUTOMOBILE_BUNDLETOOL_JAR: ` ${JAR} `, JAVA_HOME: "/jdk" },
      (system) => {
        system.addExistingFile(JAR);
        system.addExistingFile("/jdk/bin/java");
      },
    ).locate();

    expect(lookup).toEqual({
      found: true,
      command: {
        file: path.join("/jdk", "bin", "java"),
        args: ["-jar", JAR],
        location: JAR,
        source: "jar",
      },
    });
  });

  test("a configured jar falls back to java on PATH", async () => {
    const lookup = await locator({ AUTOMOBILE_BUNDLETOOL_JAR: JAR }, (system) => {
      system.addExistingFile(JAR);
      system.setExecResponse("which java", "/usr/bin/java\n");
    }).locate();

    expect(lookup).toMatchObject({ found: true, command: { file: "/usr/bin/java" } });
  });

  test("a configured jar wins over a bundletool on PATH", async () => {
    const lookup = await locator({ AUTOMOBILE_BUNDLETOOL_JAR: JAR }, (system) => {
      system.addExistingFile(JAR);
      system.setExecResponse("which java", "/usr/bin/java");
      system.setExecResponse("which bundletool", "/usr/local/bin/bundletool");
    }).locate();

    expect(lookup).toMatchObject({ found: true, command: { source: "jar" } });
  });

  test("a missing jar is reported, not silently replaced by PATH", async () => {
    const lookup = await locator({ AUTOMOBILE_BUNDLETOOL_JAR: JAR }, (system) => {
      system.setExecResponse("which bundletool", "/usr/local/bin/bundletool");
    }).locate();

    expect(lookup).toEqual({
      found: false,
      reason: `AUTOMOBILE_BUNDLETOOL_JAR points at a missing file: ${JAR}`,
    });
  });

  test("a jar without any java is reported", async () => {
    const lookup = await locator({ AUTOMOBILE_BUNDLETOOL_JAR: JAR }, (system) =>
      system.addExistingFile(JAR),
    ).locate();

    expect(lookup).toMatchObject({ found: false, reason: expect.stringContaining("no java") });
  });

  test("a bundletool launcher on PATH is used when no jar is configured", async () => {
    const lookup = await locator({}, (system) =>
      system.setExecResponse("which bundletool", "/opt/homebrew/bin/bundletool\n"),
    ).locate();

    expect(lookup).toEqual({
      found: true,
      command: {
        file: "/opt/homebrew/bin/bundletool",
        args: [],
        location: "/opt/homebrew/bin/bundletool",
        source: "path",
      },
    });
  });

  test("nothing configured and nothing on PATH is not found", async () => {
    expect(await locator({}).locate()).toEqual({
      found: false,
      reason: "bundletool is not on PATH and AUTOMOBILE_BUNDLETOOL_JAR is not set",
    });
  });
});

describe("requireBundletool", () => {
  test("throws the typed error with the install steps", async () => {
    const missing = new FakeBundletoolLocator();
    missing.setMissing("nope");

    const error = await requireBundletool(missing, ".aab").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BundletoolNotFoundError);
    expect((error as BundletoolNotFoundError).reason).toBe("nope");
    expect((error as Error).name).toBe("BundletoolNotFoundError");
    expect((error as Error).message).toStartWith(
      "bundletool is required to install .aab artifacts on Android but was not found: nope.",
    );
  });
});
