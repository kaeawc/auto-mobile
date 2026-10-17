import { describe, expect, test } from "bun:test";
import * as daemonLauncher from "../../src/daemon/DaemonLauncher";
import * as emulatorLossDaemon from "../../src/daemon/emulatorLossIncident";
import * as lockOwnerDaemon from "../../src/daemon/lockOwnerGeneration";
import * as processGenerationDaemon from "../../src/daemon/processGeneration";
import * as processGenerationFieldsDaemon from "../../src/daemon/processGenerationFields";
import * as daemonProcessCommand from "../../src/utils/daemonProcessCommand";
import * as emulatorLossUtils from "../../src/utils/emulatorLossIncident";
import * as lockOwnerUtils from "../../src/utils/lockOwnerGeneration";
import * as processGenerationUtils from "../../src/utils/processGeneration";
import * as processGenerationFieldsUtils from "../../src/utils/processGenerationFields";

describe("tier import direction re-exports (#11789)", () => {
  test("legacy daemon paths re-export the utils implementations", () => {
    expect(lockOwnerDaemon.defaultLockOwnerGenerationProbe).toBe(
      lockOwnerUtils.defaultLockOwnerGenerationProbe,
    );
    expect(processGenerationDaemon.compareProcessGenerationTokens).toBe(
      processGenerationUtils.compareProcessGenerationTokens,
    );
    expect(processGenerationFieldsDaemon).toEqual(processGenerationFieldsUtils);
    expect(emulatorLossDaemon.InMemoryEmulatorLossIncidentStore).toBe(
      emulatorLossUtils.InMemoryEmulatorLossIncidentStore,
    );
    expect(daemonLauncher.runDaemonProcessCommand).toBe(
      daemonProcessCommand.runDaemonProcessCommand,
    );
  });
});
