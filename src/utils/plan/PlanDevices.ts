import { PlanDevice, PlanDeviceDefinition } from "../../models/Plan";

const isDeviceDefinition = (device: PlanDevice): device is PlanDeviceDefinition => {
  return typeof device === "object" && device !== null && !Array.isArray(device);
};

type NormalizedPlanDevices = {
  labels: string[];
  definitions: PlanDeviceDefinition[];
  hasDefinitions: boolean;
  hasLabels: boolean;
};

export const normalizePlanDevices = (devices?: PlanDevice[]): NormalizedPlanDevices => {
  const labels: string[] = [];
  const definitions: PlanDeviceDefinition[] = [];
  let hasDefinitions = false;
  let hasLabels = false;

  if (!devices) {
    return { labels, definitions, hasDefinitions, hasLabels };
  }

  for (const device of devices) {
    if (typeof device === "string") {
      labels.push(device);
      hasLabels = true;
      continue;
    }

    if (isDeviceDefinition(device)) {
      labels.push(device.label);
      definitions.push(device);
      hasDefinitions = true;
      continue;
    }
  }

  return { labels, definitions, hasDefinitions, hasLabels };
};

export const getPlanDeviceLabels = (devices?: PlanDevice[]): string[] => {
  return normalizePlanDevices(devices).labels;
};

/**
 * The platform a plan declares for a device label (`devices: [{ label, platform }]`), or
 * undefined for a label-only plan or an unknown label. The orchestrator allocates each label's
 * device by this same definition, so it is the platform the label's steps must run with.
 */
export const getPlanDevicePlatform = (
  devices: PlanDevice[] | undefined,
  label: string,
): PlanDeviceDefinition["platform"] | undefined => {
  return normalizePlanDevices(devices).definitions.find((definition) => definition.label === label)
    ?.platform;
};
