import { EmulatorLossIncidentRepository } from "../db/emulatorLossIncidentRepository";
import type { EmulatorLossIncident } from "../daemon/emulatorLossIncident";
import { logger } from "../utils/logger";
import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import { EMULATOR_LOSS_INCIDENT_RESOURCE_URIS } from "./emulatorLossIncidentResourceUris";

interface EmulatorLossIncidentReader {
  list(limit?: number): Promise<EmulatorLossIncident[]>;
}

export interface EmulatorLossIncidentResourceDependencies {
  reader?: EmulatorLossIncidentReader;
}

async function getIncidentArchive(
  deps: EmulatorLossIncidentResourceDependencies = {},
): Promise<ResourceContent> {
  try {
    const incidents = await (deps.reader ?? new EmulatorLossIncidentRepository()).list();
    return {
      uri: EMULATOR_LOSS_INCIDENT_RESOURCE_URIS.ARCHIVE,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          incidents,
          count: incidents.length,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.warn(`[EmulatorLossIncidentResources] Failed to list incidents: ${error}`, error);
    return {
      uri: EMULATOR_LOSS_INCIDENT_RESOURCE_URIS.ARCHIVE,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: "Failed to list emulator-loss incidents.",
        },
        null,
        2,
      ),
    };
  }
}

export function registerEmulatorLossIncidentResources(
  deps: EmulatorLossIncidentResourceDependencies = {},
): void {
  ResourceRegistry.register(
    EMULATOR_LOSS_INCIDENT_RESOURCE_URIS.ARCHIVE,
    "Android Emulator Loss Incidents",
    "Bounded diagnostics and recovery outcomes for unexpectedly lost Android emulators.",
    "application/json",
    () => getIncidentArchive(deps),
  );
}
