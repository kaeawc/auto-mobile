import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";

const WORKFLOW_PATH = ".github/workflows/webrtc-device-integration.yml";

interface WorkflowDocument {
  permissions?: Record<string, string>;
  on?: {
    pull_request?: { types?: string[] };
    workflow_dispatch?: { inputs?: Record<string, unknown> };
  };
  jobs?: Record<string, {
    needs?: string | string[];
    if?: string;
    steps?: Array<{
      id?: string;
      name?: string;
      uses?: string;
      if?: string;
      "continue-on-error"?: boolean;
      with?: {
        filters?: string;
        "gradle-tasks"?: string;
        script?: string;
        path?: string;
        "if-no-files-found"?: string;
      };
    }>;
  }>;
}

function workflow(): WorkflowDocument {
  expect(existsSync(WORKFLOW_PATH)).toBe(true);
  return load(readFileSync(WORKFLOW_PATH, "utf8")) as WorkflowDocument;
}

describe("#4308 device WebRTC integration workflow", () => {
  test("offers PR label triggering and an explicit manual diagnostic path", () => {
    const document = workflow();

    expect(document.on?.pull_request?.types).toContain("labeled");
    expect(document.on?.workflow_dispatch?.inputs).toHaveProperty("platform");
    expect(document.permissions?.["pull-requests"]).toBe("read");
  });

  test("defines the exact WebRTC path set that enables device lanes", () => {
    const document = workflow();
    const filter = document.jobs?.["detect-webrtc-changes"]?.steps?.find(step => step.id === "filter");

    expect(filter?.uses).toBe("dorny/paths-filter@v3");
    expect(filter?.with?.filters).toContain("src/features/webrtc/**");
    expect(filter?.with?.filters).toContain("src/features/screen-stream/**");
    expect(filter?.with?.filters).toContain("android/video-server/**");
    expect(filter?.with?.filters).toContain("ios/screen-capture/**");
    expect(filter?.with?.filters).toContain("src/server/webrtcStreamManager.ts");
    expect(filter?.with?.filters).toContain("src/daemon/webrtcStream*");
    expect(filter?.with?.filters).toContain("src/daemon/videoStreamSocket*");
    expect(filter?.with?.filters).toContain("src/daemon/videoStreamFraming.ts");
    expect(filter?.with?.filters).toContain("src/daemon/daemonFiles.ts");
    expect(filter?.with?.filters).toContain("src/daemon/socketServer/**");
    expect(filter?.with?.filters).not.toContain("src/index.ts");
    expect(filter?.with?.filters).toContain("examples/mediamtx/**");
    expect(filter?.with?.filters).toContain("scripts/webrtc/**");
    expect(filter?.with?.filters).toContain("test/integration/webrtcDeviceCapture.integration.test.ts");
    // The stage-latency helper runs inside the device lane, so a change to it
    // has to re-run that lane (#4343).
    expect(filter?.with?.filters).toContain("test/helpers/captureStageTimeline.ts");
    expect(filter?.with?.filters).toContain(WORKFLOW_PATH);
  });

  test("runs neither device lane for unrelated PR changes, but the webrtc label forces both", () => {
    const document = workflow();
    const android = document.jobs?.["android-device-webrtc"];
    const ios = document.jobs?.["ios-device-webrtc"];

    for (const job of [android, ios]) {
      expect(job?.needs).toContain("detect-webrtc-changes");
      expect(job?.if).toContain("needs.detect-webrtc-changes.outputs.should_run == 'true'");
      expect(job?.if).toContain("github.event.pull_request.labels.*.name, 'webrtc'");
      expect(job?.if).toContain("inputs.platform");
    }
    expect(android?.if).toContain("inputs.platform == 'android'");
    expect(ios?.if).toContain("inputs.platform == 'ios'");
  });

  test("builds the CtrlProxy APK before the Android emulator composite installs it", () => {
    const androidSteps = workflow().jobs?.["android-device-webrtc"]?.steps ?? [];
    const buildIndex = androidSteps.findIndex(step => step.name === "Build CtrlProxy APK");
    const emulatorIndex = androidSteps.findIndex(step => step.uses === "./.github/actions/android-emulator");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(androidSteps[buildIndex]?.with?.["gradle-tasks"]).toContain(":control-proxy:assembleDebug");
    expect(emulatorIndex).toBeGreaterThan(buildIndex);
  });

  test("keeps the stage-latency artifacts from passing runs without making the upload required (#4343)", () => {
    const document = workflow();

    for (const jobId of ["android-device-webrtc", "ios-device-webrtc"]) {
      const upload = document.jobs?.[jobId]?.steps?.find(
        step => step.uses?.startsWith("actions/upload-artifact") === true
      );

      expect(upload?.if).toBe("always()");
      expect(upload?.["continue-on-error"]).toBe(true);
      expect(upload?.with?.path).toBe("scratch/webrtc-device-integration/");
      expect(upload?.with?.["if-no-files-found"]).toBe("ignore");
    }
  });

  test("uses the checkout's video-server jar for Android capture", () => {
    const androidSteps = workflow().jobs?.["android-device-webrtc"]?.steps ?? [];
    const build = androidSteps.find(step => step.name === "Build video-server jar");
    const emulator = androidSteps.find(step => step.uses === "./.github/actions/android-emulator");

    expect(build?.with?.["gradle-tasks"]).toContain(":video-server:d8Dex");
    expect(emulator?.with?.script).toContain("AUTOMOBILE_VIDEO_SERVER_JAR");
    expect(emulator?.with?.script).toContain("AUTOMOBILE_REQUIRE_VIDEO_SERVER=1");
  });
});
