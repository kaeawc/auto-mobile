import { z } from "zod";
import type { ContractFinding } from "./boundaries";
import type { SdkContractManifest } from "./manifest";

export const NAVIGATION_SLICE = "navigation";
export const NAVIGATION_FAMILIES = [
  "webview.wkwebview",
  "navigation.uikit",
  "navigation.swiftui",
  "navigation.deeplink",
  "navigation.custom",
] as const;

const eventSchema = z.object({
  source: z.string(),
  destination: z.string(),
  sequenceNumber: z.number().int().positive(),
  sceneIdentifier: z.string().optional(),
  transitionCompleted: z.boolean(),
});
const webEventSchema = z.object({ webViewId: z.string(), name: z.string() });

/** Judges SDK bytes, never an invented sequence assigned by the fixture. */
export function judgeNavigation(manifest: SdkContractManifest): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const fail = (
    caseName: string,
    message: string,
    boundary: ContractFinding["boundary"] = "sdk-adapter",
  ) => {
    findings.push({ slice: NAVIGATION_SLICE, caseName, message, boundary });
  };
  const log = manifest.navigation;
  if (!log || !manifest.capabilities) {
    fail("run", "missing navigation log or capability observation", "fixture-host");
    return findings;
  }
  for (const stage of ["beforeRegistration", "afterRegistration"] as const) {
    const descriptors = manifest.capabilities[stage];
    for (const id of NAVIGATION_FAMILIES) {
      const matches = descriptors.filter((item) => item.id === id);
      const descriptor = matches[0];
      const before = stage === "beforeRegistration";
      if (
        matches.length !== 1 ||
        descriptor?.state !== (before ? "DISABLED" : "SUPPORTED") ||
        descriptor.reason !== (before ? "HOST_OPT_IN" : undefined) ||
        descriptor.faultEnforcement !== "NONE" ||
        descriptor.faultActions?.length !== 0
      ) {
        fail(
          `${stage}/${id}`,
          "expected exactly one descriptor with the registered state and HOST_OPT_IN before registration",
        );
      }
    }
    if (descriptors.length !== NAVIGATION_FAMILIES.length) {
      fail(stage, "unexpected capability descriptors");
    }
  }
  const events: z.infer<typeof eventSchema>[] = [];
  const webNames: string[] = [];
  for (const envelope of manifest.events) {
    if (envelope.eventType !== "navigation" && envelope.eventType !== "webview") {
      continue;
    }
    try {
      const payload: unknown = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
      if (envelope.eventType === "navigation") {
        events.push(eventSchema.parse(payload));
      } else {
        const event = webEventSchema.parse(payload);
        if (event.webViewId !== "contract-navigation") {
          fail("webview", "unexpected web view in fixture stream");
        }
        if (event.name.startsWith("navigation_")) {
          webNames.push(event.name);
        }
      }
    } catch {
      fail(
        "payload",
        "SDK emitted an invalid navigation or web lifecycle payload",
        "sdk-serialization",
      );
    }
  }
  if (manifest.undecodableBatches !== 0) {
    fail("batches", "SDK batches could not be decoded", "sdk-serialization");
  }
  if (
    JSON.stringify(events) !== JSON.stringify(log.events.map((event) => eventSchema.parse(event)))
  ) {
    fail(
      "manifest-stream",
      "manifest navigation log differs from the SDK envelopes",
      "fixture-host",
    );
  }
  const expected = [
    ["uikit_navigation", "UIViewController"],
    ["swiftui_navigation", "contract-swiftui"],
    ["deep_link", "contract-deeplink"],
    ["custom", "contract-custom"],
    ...(log.multiScene === "complete" ? [["custom", "contract-second-scene"]] : []),
  ];
  if (events.length !== expected.length) {
    fail("transitions", `expected ${expected.length} events, got ${events.length}`);
  }
  expected.forEach(([source, destination], index) => {
    const event = events[index];
    const scene = log.sceneIdentifiers[index === 4 ? 1 : 0];
    if (
      !event ||
      event.source !== source ||
      event.destination !== destination ||
      !event.transitionCompleted ||
      !scene ||
      event.sceneIdentifier !== scene
    ) {
      fail(
        `transition-${index}`,
        "missing, duplicated, reordered or incorrect completed transition / scene",
      );
    }
  });
  events.forEach((event, index) => {
    if (index > 0 && event.sequenceNumber !== events[index - 1]!.sequenceNumber + 1) {
      fail(
        "sequence",
        "SDK sequence numbers must ascend without gaps or duplicates",
        "sdk-serialization",
      );
    }
  });
  if ((log.deviceClass === "ipad") !== (log.multiScene === "complete")) {
    fail(
      "device-class",
      "iPad requires a completed multi-scene transition; iPhone reports not applicable",
      "fixture-host",
    );
  }
  const sceneCount = log.multiScene === "complete" ? 2 : 1;
  if (
    log.sceneIdentifiers.length !== sceneCount ||
    new Set(log.sceneIdentifiers).size !== sceneCount
  ) {
    fail("scenes", "multi-scene must use two distinct actual scene identifiers", "fixture-host");
  }
  if (
    JSON.stringify(webNames) !== JSON.stringify(["navigation_committed", "navigation_finished"])
  ) {
    fail("webview", "expected exactly one ordered commit/finish lifecycle from the host delegate");
  }
  return findings;
}
