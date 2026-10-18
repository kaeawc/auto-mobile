import { DefaultAccessibilityDetector } from "../../src/features/accessibility/AccessibilityDetector";
import { CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT } from "../../src/ctrlProxy/constants";
import { FakeAccessibilityDetector } from "../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  runAccessibilityDetectorContract,
  type AccessibilityScenario,
} from "./AccessibilityDetectorContract";

const TALKBACK =
  "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService";
const OTHER = "com.example.reader/com.example.reader.ReaderService";

const settingsOutput = (scenario: AccessibilityScenario): string => {
  if (scenario.kind === "unavailable") {
    return "";
  }
  const services = [
    scenario.kind === "talkback" ? TALKBACK : null,
    scenario.kind === "other" ? OTHER : null,
    scenario.ctrlProxy ? CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT : null,
  ].filter((service): service is string => service !== null);
  return services.length === 0 ? "null" : services.join(":");
};

runAccessibilityDetectorContract("DefaultAccessibilityDetector over stubbed adb", () => {
  const adbs = new Map<string, FakeAdbExecutor>();
  const adbFor = (deviceId: string): FakeAdbExecutor => {
    const existing = adbs.get(deviceId) ?? new FakeAdbExecutor();
    adbs.set(deviceId, existing);
    return existing;
  };
  return {
    detector: new DefaultAccessibilityDetector(new FakeTimer()),
    adbFor,
    configure: (deviceId, scenario) => {
      const adb = adbFor(deviceId);
      adb.setCommandResponse("enabled_accessibility_services", {
        stdout: settingsOutput(scenario),
        stderr: "",
        ...(scenario.kind === "unavailable" ? { error: "device offline" } : {}),
        toString: () => "",
        trim: () => "",
        includes: () => false,
      });
    },
  };
});

runAccessibilityDetectorContract("FakeAccessibilityDetector", () => {
  const detector = new FakeAccessibilityDetector();
  return {
    detector,
    adbFor: () => new FakeAdbExecutor(),
    configure: (deviceId, scenario) => {
      if (scenario.kind === "unavailable") {
        detector.setDetectionResult(deviceId, null);
        detector.setCtrlProxyServiceEnabled(deviceId, null);
        return;
      }
      detector.setDetectionResult(
        deviceId,
        scenario.kind !== "none",
        scenario.kind === "talkback" ? "talkback" : "unknown",
      );
      detector.setCtrlProxyServiceEnabled(deviceId, scenario.ctrlProxy);
    },
  };
});
