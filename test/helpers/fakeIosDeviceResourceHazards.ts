import type { IosDeviceResourceHazard } from "../../src/utils/iosDeviceResourceHazards";

export const fakeIosDeviceResourceHazards: readonly IosDeviceResourceHazard[] = [
  {
    id: "fake-spin",
    resources: ["calendarServices", "reminderServices"],
    appliesTo: ["post_boot", "preboot"],
    reason: "Fake CPU spin",
    evidence: "Injected test evidence",
  },
];
