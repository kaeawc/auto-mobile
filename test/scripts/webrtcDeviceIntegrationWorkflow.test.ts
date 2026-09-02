import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";

const PULL_REQUEST_WORKFLOW = ".github/workflows/pull_request.yml";
const MERGE_WORKFLOW = ".github/workflows/merge.yml";
const DELETED_STANDALONE_WORKFLOW = ".github/workflows/webrtc-device-integration.yml";
const DEVICE_JOB_IDS = ["android-device-webrtc", "ios-device-webrtc"] as const;

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  with?: {
    filters?: string;
    "gradle-tasks"?: string;
    script?: string;
    name?: string;
    path?: string;
    "if-no-files-found"?: string;
  };
}

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  permissions?: Record<string, string>;
  on?: {
    pull_request?: { types?: string[] };
  };
  jobs?: Record<string, WorkflowJob>;
}

function workflow(path: string): WorkflowDocument {
  return load(readFileSync(path, "utf8")) as WorkflowDocument;
}

function jobSteps(path: string, jobId: string): WorkflowStep[] {
  return workflow(path).jobs?.[jobId]?.steps ?? [];
}

describe("#4308 device WebRTC integration workflow", () => {
  test("folds device coverage into PR label triggering and an unconditional merge backstop", () => {
    const pullRequest = workflow(PULL_REQUEST_WORKFLOW);
    const merge = workflow(MERGE_WORKFLOW);

    expect(existsSync(DELETED_STANDALONE_WORKFLOW)).toBe(false);
    expect(pullRequest.on?.pull_request?.types).toContain("labeled");
    expect(pullRequest.permissions?.["pull-requests"]).toBe("write");
    for (const jobId of DEVICE_JOB_IDS) {
      expect(pullRequest.jobs?.[jobId]).toBeDefined();
      expect(merge.jobs?.[jobId]).toBeDefined();
    }
  });

  test("defines the exact WebRTC path set that enables PR device lanes", () => {
    const filter = workflow(PULL_REQUEST_WORKFLOW).jobs?.["detect-changes"]?.steps?.find(
      (step) => step.id === "filter-webrtc",
    );

    expect(filter?.uses).toBe("dorny/paths-filter@v3");
    for (const path of [
      "src/features/webrtc/**",
      "src/features/screen-stream/**",
      "android/video-server/**",
      "ios/screen-capture/**",
      "src/server/webrtcStreamManager.ts",
      "src/daemon/webrtc*",
      "src/daemon/videoStreamSocket*",
      "src/daemon/videoStreamFraming.ts",
      "src/daemon/daemonFiles.ts",
      "src/daemon/socketServer/**",
      "examples/mediamtx/**",
      "scripts/webrtc/**",
      "test/integration/webrtcDeviceCapture.integration.test.ts",
      "test/helpers/captureStageTimeline.ts",
      PULL_REQUEST_WORKFLOW,
      MERGE_WORKFLOW,
    ]) {
      expect(filter?.with?.filters).toContain(path);
    }
    expect(filter?.with?.filters).not.toContain("src/index.ts");
  });

  test("gates both PR device lanes through shared detection while merge runs both unconditionally", () => {
    const pullRequest = workflow(PULL_REQUEST_WORKFLOW);
    const merge = workflow(MERGE_WORKFLOW);

    expect(pullRequest.jobs?.["android-device-webrtc"]?.needs).toEqual([
      "detect-changes",
      "build-android-control-proxy",
    ]);
    expect(pullRequest.jobs?.["ios-device-webrtc"]?.needs).toBe("detect-changes");
    for (const jobId of DEVICE_JOB_IDS) {
      expect(pullRequest.jobs?.[jobId]?.if).toBe(
        "needs.detect-changes.outputs.webrtc_should_run == 'true'",
      );
      expect(merge.jobs?.[jobId]?.needs).toBe(
        jobId === "android-device-webrtc" ? "build-android-control-proxy" : undefined,
      );
      expect(merge.jobs?.[jobId]?.if).toBeUndefined();
    }
  });

  test("downloads existing Android products before the emulator composite installs them", () => {
    for (const path of [PULL_REQUEST_WORKFLOW, MERGE_WORKFLOW]) {
      const steps = jobSteps(path, "android-device-webrtc");
      const apkIndex = steps.findIndex((step) => step.name === "Download CtrlProxy APK");
      const jarIndex = steps.findIndex((step) => step.name === "Download video-server jar");
      const emulatorIndex = steps.findIndex(
        (step) => step.uses === "./.github/actions/android-emulator",
      );

      expect(steps[apkIndex]?.uses).toBe("actions/download-artifact@v7");
      expect(steps[apkIndex]?.with?.name).toBe("control-proxy-apk");
      expect(steps[jarIndex]?.uses).toBe("actions/download-artifact@v7");
      expect(steps[jarIndex]?.with?.name).toBe("video-server-jar");
      expect(emulatorIndex).toBeGreaterThan(apkIndex);
      expect(emulatorIndex).toBeGreaterThan(jarIndex);
    }
  });

  test("publishes the Android products from the shared build job", () => {
    for (const path of [PULL_REQUEST_WORKFLOW, MERGE_WORKFLOW]) {
      const steps = jobSteps(path, "build-android-control-proxy");
      const build = steps.find((step) => step.uses === "./.github/actions/gradle-task-run");
      const apk = steps.find((step) => step.name === "Upload CtrlProxy APK");
      const jar = steps.find((step) => step.name === "Upload video-server jar");

      expect(build?.with?.["gradle-tasks"]).toContain(":video-server:d8Dex");
      expect(apk?.with?.name).toBe("control-proxy-apk");
      expect(jar?.with?.name).toBe("video-server-jar");
      expect(jar?.with?.path).toBe("android/video-server/build/libs/automobile-video.jar");
    }
  });

  test("keeps stage-latency artifacts from passing runs without making uploads required", () => {
    for (const path of [PULL_REQUEST_WORKFLOW, MERGE_WORKFLOW]) {
      const document = workflow(path);
      for (const jobId of DEVICE_JOB_IDS) {
        const upload = document.jobs?.[jobId]?.steps?.find(
          (step) => step.uses?.startsWith("actions/upload-artifact") === true,
        );

        expect(upload?.if).toBe("always()");
        expect(upload?.["continue-on-error"]).toBe(true);
        expect(upload?.with?.path).toBe("scratch/webrtc-device-integration/");
        expect(upload?.with?.["if-no-files-found"]).toBe("ignore");
        expect(upload?.with?.name).toContain("github.run_attempt");
      }
    }
  });

  test("prints the result-reading legend in every device lane, even on failure", () => {
    for (const path of [PULL_REQUEST_WORKFLOW, MERGE_WORKFLOW]) {
      for (const [jobId, platform] of [
        ["android-device-webrtc", "android"],
        ["ios-device-webrtc", "ios"],
      ] as const) {
        const steps = jobSteps(path, jobId);
        const explain = steps.find((step) => step.name === "Explain WebRTC device results");

        expect(explain?.if).toBe("always()");
        expect(explain?.run).toContain("scripts/webrtc/explain-device-results.sh");
        expect(explain?.run).toContain(platform);
        expect(explain?.["continue-on-error"]).toBe(true);

        const explainIndex = steps.indexOf(explain!);
        const uploadIndex = steps.findIndex(
          (step) => step.uses?.startsWith("actions/upload-artifact") === true,
        );
        expect(explainIndex).toBeGreaterThanOrEqual(0);
        expect(uploadIndex).toBeGreaterThan(explainIndex);
      }
    }
  });

  test("uses the checkout's video-server jar for Android capture", () => {
    for (const path of [PULL_REQUEST_WORKFLOW, MERGE_WORKFLOW]) {
      const steps = jobSteps(path, "android-device-webrtc");
      const emulator = steps.find((step) => step.uses === "./.github/actions/android-emulator");

      expect(emulator?.with?.script).toContain("AUTOMOBILE_VIDEO_SERVER_JAR");
      expect(emulator?.with?.script).toContain("AUTOMOBILE_REQUIRE_VIDEO_SERVER=1");
    }
  });

  test("uses an explicit checkout helper only for the iOS integration fixture", () => {
    for (const path of [PULL_REQUEST_WORKFLOW, MERGE_WORKFLOW]) {
      const runCapture = jobSteps(path, "ios-device-webrtc").find(
        (step) => step.name === "Run iOS device capture integration",
      );

      expect(runCapture?.env?.AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER).toContain(
        "ios/screen-capture/.build/debug/screen-capture-helper",
      );
    }
  });

  test("waits for the product-booted Simulator window before iOS capture", () => {
    for (const path of [PULL_REQUEST_WORKFLOW, MERGE_WORKFLOW]) {
      const steps = jobSteps(path, "ios-device-webrtc");
      const boot = steps.find((step) => step.name === "Boot and activate iOS Simulator");
      const capture = steps.find((step) => step.name === "Run iOS device capture integration");

      expect(boot).toBeDefined();
      expect(capture).toBeDefined();
      expect(boot?.run).toContain(
        "bun run src/index.ts --boot-device --platform ios --create-if-missing --timeout-ms 600000",
      );
      expect(boot?.run).toContain("jq -r '.deviceId'");
      expect(boot?.run).toContain("killall Simulator");
      expect(boot?.run).toContain("open -a Simulator --args -CurrentDeviceUDID");
      expect(boot?.run).toContain("xcrun simctl list devices --json");
      expect(boot?.run).toContain('"${helper_path}" --list-simulators');
      expect(boot?.run).toContain("simulator_window_ready=0");
      expect(boot?.run).toContain(
        "Selected Simulator window did not become discoverable by ScreenCaptureKit",
      );
      expect(steps.indexOf(boot!)).toBeLessThan(steps.indexOf(capture!));
    }
  });
});
