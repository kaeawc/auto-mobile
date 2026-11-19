import { describe, expect, test } from "bun:test";
import type { BuildAppRequest, BuildAppResult } from "../../src/features/build/BuildApp";
import { buildAppSchema, createBuildAppHandler } from "../../src/server/buildAppTools";

function fakeRunner(result: BuildAppResult) {
  const requests: BuildAppRequest[] = [];
  return {
    requests,
    build: async (request: BuildAppRequest) => {
      requests.push(request);
      return result;
    },
  };
}

describe("buildApp tool", () => {
  test("a successful build names the artifact and points at installApp", async () => {
    const runner = fakeRunner({
      success: true,
      platform: "tvos",
      artifactPath: "/p/TvApp.app",
      artifactPaths: ["/p/TvApp.app"],
      command: ["xcodebuild"],
    });
    const response = await createBuildAppHandler(runner)(
      buildAppSchema.parse({
        platform: "tvos",
        projectPath: "/p/TvApp.xcodeproj",
        scheme: "TvApp",
      }),
    );

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      success: true,
      artifactPath: "/p/TvApp.app",
    });
    expect(response.content[0].text).toContain("installApp");
    expect(runner.requests[0].scheme).toBe("TvApp");
  });

  test("a failed build is an error result carrying the code", async () => {
    const runner = fakeRunner({
      success: false,
      platform: "android",
      errorCode: "build_failed",
      error: "gradlew failed",
      logExcerpt: "e: boom",
    });
    const response = await createBuildAppHandler(runner)(
      buildAppSchema.parse({ platform: "android", projectPath: "/droid" }),
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      errorCode: "build_failed",
      logExcerpt: "e: boom",
    });
  });

  test("rejects unknown keys and platforms", () => {
    expect(
      buildAppSchema.safeParse({ platform: "tvos", projectPath: "/p", appPath: "/x" }).success,
    ).toBe(false);
    expect(buildAppSchema.safeParse({ platform: "web", projectPath: "/p" }).success).toBe(false);
  });
});
