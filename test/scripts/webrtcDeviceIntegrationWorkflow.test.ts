import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";

const WORKFLOW_PATH = ".github/workflows/webrtc-device-integration.yml";

interface WorkflowDocument {
  on?: {
    pull_request?: { types?: string[] };
    workflow_dispatch?: { inputs?: Record<string, unknown> };
  };
  jobs?: Record<string, {
    needs?: string | string[];
    if?: string;
    steps?: Array<{ id?: string; uses?: string; with?: { filters?: string } }>;
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
  });

  test("defines the exact WebRTC path set that enables device lanes", () => {
    const document = workflow();
    const filter = document.jobs?.["detect-webrtc-changes"]?.steps?.find(step => step.id === "filter");

    expect(filter?.uses).toBe("dorny/paths-filter@v3");
    expect(filter?.with?.filters).toContain("src/features/webrtc/**");
    expect(filter?.with?.filters).toContain("android/video-server/**");
    expect(filter?.with?.filters).toContain("ios/screen-capture/**");
    expect(filter?.with?.filters).toContain("src/server/webrtcStreamManager.ts");
    expect(filter?.with?.filters).toContain("src/daemon/webrtcStream*");
    expect(filter?.with?.filters).toContain("examples/mediamtx/**");
    expect(filter?.with?.filters).toContain("scripts/webrtc/**");
    expect(filter?.with?.filters).toContain("test/integration/webrtcDeviceCapture.integration.test.ts");
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
});
