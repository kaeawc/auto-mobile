import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import { isProcessAlreadyGoneError } from "../ios-cmdline-tools/iosProcessErrors";
import { logger } from "../logger";
import type { ExecFileAsync } from "../HostCommandExecutor";
import type { Timer } from "../SystemTimer";
import { HealthSeedError } from "./healthSeedError";
import type { HealthAppRun, HealthSimulatorRunner } from "./healthKitSeeder";

/** Runs the seeder app through `xcrun simctl`, capturing stdout to a file the host polls. */
export class SimctlHealthSimulatorRunner implements HealthSimulatorRunner {
  constructor(
    private readonly exec: ExecFileAsync,
    private readonly timer: Pick<Timer, "sleep">,
    private readonly outputDir: string,
    private readonly polling: { maxPolls: number; intervalMs: number } = {
      maxPolls: 240,
      intervalMs: 500,
    },
  ) {}

  async install(udid: string, appPath: string): Promise<void> {
    await this.exec("xcrun", ["simctl", "install", udid, appPath]);
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    try {
      await this.exec("xcrun", ["simctl", "terminate", udid, bundleId]);
    } catch (error) {
      const message = errorMessage(error);
      if (!isProcessAlreadyGoneError(message)) {
        throw toActionableError(error, `Failed to terminate ${bundleId} before seeding`);
      }
      // Not running is the expected state before a fresh launch.
      logger.debug(`simctl terminate ${bundleId} skipped, not running: ${message}`);
    }
  }

  async launch(udid: string, bundleId: string, args: string[]): Promise<HealthAppRun> {
    const outputPath = join(this.outputDir, `hkseeder-${udid}.out`);
    await writeFile(outputPath, "");
    await this.exec("xcrun", [
      "simctl",
      "launch",
      `--stdout=${outputPath}`,
      udid,
      bundleId,
      ...args,
    ]);
    return {
      waitForOutput: async () => {
        for (let poll = 0; poll < this.polling.maxPolls; poll += 1) {
          const text = await readFile(outputPath, "utf8");
          if (/^HKPROBE done$/m.test(text)) {
            return text;
          }
          await this.timer.sleep(this.polling.intervalMs);
        }
        throw new HealthSeedError(
          "permission_denied",
          "The seeding app did not finish; the Health Access sheet was probably not accepted",
        );
      },
    };
  }
}
