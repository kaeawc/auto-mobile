import { logger } from "../../utils/logger";
import {
  templateName,
  type SimulatorTemplateKey,
} from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
import type { TemplateSimulatorClient } from "./SimulatorCreationService";
/** Re-read raw inventory immediately before deleting a manifest-owned simulator. */
export async function deleteTemplateSimulator(
  client: Pick<TemplateSimulatorClient, "listSimulators" | "deleteSimulator">,
  key: SimulatorTemplateKey,
  udid: string,
  signal?: AbortSignal,
): Promise<void> {
  const list = await client.listSimulators(undefined, signal);
  const sim = Object.values(list.devices)
    .flat()
    .find((entry) => entry.udid === udid);
  if (!sim) {
    return;
  }
  if (sim.name !== templateName(key)) {
    logger.warn(`Refusing template deletion: ${udid} is named ${sim.name}`);
    return;
  }
  await client.deleteSimulator(udid, { signal });
}
