import { readFileSync } from "node:fs";
/** Valid synthetic device-set paths; no host filesystem or home-directory lookups. */
export const simulatorDeviceSetRoot = "/simulators";
export const simulatorContainerUuid = "877F3F94-D9DE-4772-A0BA-38F2F5794968";
export const simulatorOwnership = {
  deviceSetRoot: simulatorDeviceSetRoot,
  identity: { containerIdentifier: async () => null },
};
export function simulatorDataContainer(
  deviceId: string,
  uuid = simulatorContainerUuid,
  deviceSetRoot = simulatorDeviceSetRoot,
): string {
  return `${deviceSetRoot}/${deviceId}/data/Containers/Data/Application/${uuid}`;
}

/** Captured template registration, remapped only after a fake metadata proof. */
export const capturedTemplateContainer = readFileSync(
  new URL("../fixtures/ios-simctl/residue-safari-clone-container.txt", import.meta.url),
  "utf8",
).trim();
export function cloneContainerFixture(deviceId: string, identifier: string | null) {
  const templateDeviceId = "4C4FD11F-2766-4332-9DFF-56073DFEB085";
  const deviceSetRoot = capturedTemplateContainer.split(`/${templateDeviceId}/`)[0]!;
  const own = capturedTemplateContainer.replace(templateDeviceId, deviceId);
  const inspected: string[] = [];
  return {
    own,
    reported: capturedTemplateContainer,
    inspected,
    ownership: {
      deviceSetRoot,
      identity: {
        containerIdentifier: async (path: string) => {
          inspected.push(path);
          return identifier;
        },
      },
    },
  };
}
