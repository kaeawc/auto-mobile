import { z } from "zod/v4";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { SimCtlClient } from "./SimCtlClient";
import { parseSimctlDeviceList } from "./simctlDeviceList";

const endpointSchema = z.object({ deviceId: z.string(), name: z.string(), state: z.string() });
export const simulatorPairSchema = z.object({
  pairId: z.string(),
  state: z.enum(["active", "inactive"]),
  connection: z.enum(["connected", "disconnected"]),
  watch: endpointSchema,
  phone: endpointSchema,
});
export const watchPairResultSchema = simulatorPairSchema.omit({ watch: true, phone: true }).extend({
  phoneDeviceId: z.string(),
  created: z.boolean(),
});
export type SimulatorPair = z.infer<typeof simulatorPairSchema>;
export type WatchPairResult = z.infer<typeof watchPairResultSchema>;
const capturedEndpoint = z.object({ udid: z.string(), name: z.string(), state: z.string() });
const capturedPairs = z.object({
  pairs: z.record(
    z.string(),
    z.object({
      state: z.enum(["(active, connected)", "(active, disconnected)", "(inactive, disconnected)"]),
      watch: capturedEndpoint,
      phone: capturedEndpoint,
    }),
  ),
});

export function parseSimulatorPairs(stdout: string): SimulatorPair[] {
  return Object.entries(capturedPairs.parse(JSON.parse(stdout)).pairs).map(([pairId, pair]) => ({
    pairId,
    state: pair.state.startsWith("(active,") ? "active" : "inactive",
    connection: pair.state === "(active, connected)" ? "connected" : "disconnected",
    watch: { deviceId: pair.watch.udid, name: pair.watch.name, state: pair.watch.state },
    phone: { deviceId: pair.phone.udid, name: pair.phone.name, state: pair.phone.state },
  }));
}
export const simulatorPairArgs = {
  list: (): string[] => ["list", "pairs", "-j"],
  pair: (watch: string, phone: string): string[] => ["pair", watch, phone],
  activate: (id: string): string[] => ["pair_activate", id],
  unpair: (id: string): string[] => ["unpair", id],
};
export function isMaximumPairingError(message: string): boolean {
  return (
    message.includes("code=403") &&
    message.includes("already paired with the maximum number of supported devices")
  );
}
export function isAlreadyActiveError(message: string): boolean {
  return (
    message.includes("NSPOSIXErrorDomain") &&
    message.includes("code=37") &&
    message.includes("This pair is already active.")
  );
}
function pairingRefusal(watch: string, existing?: SimulatorPair): ActionableError {
  return new ActionableError(
    `Apple Watch ${watch} is already paired${existing ? ` in pair ${existing.pairId} with iPhone '${existing.phone.name}' (${existing.phone.deviceId})` : " with the maximum number of supported devices"}. Unpair it first, or pass that phone's UDID as pairWithDeviceId.`,
  );
}
const createdPairs = new Map<string, string>();
/** Only pairs created in this daemon process are eligible for automatic cleanup. */
export class SimulatorPairService {
  constructor(
    private readonly simctl: Pick<SimCtlClient, "executeCommandArgs">,
    private readonly owned: Map<string, string> = createdPairs,
  ) {}

  async list(signal?: AbortSignal): Promise<SimulatorPair[]> {
    try {
      return parseSimulatorPairs(
        (await this.simctl.executeCommandArgs(simulatorPairArgs.list(), undefined, signal)).stdout,
      );
    } catch (error) {
      throw toActionableError(
        error,
        "Failed to list simulator pairs; check Xcode's simulator inventory",
      );
    }
  }

  async ensure(watch: string, phone: string, signal?: AbortSignal): Promise<WatchPairResult> {
    await this.validatePhone(phone, signal);
    const existing = (await this.list(signal)).find((pair) => pair.watch.deviceId === watch);
    if (existing && existing.phone.deviceId !== phone) {
      throw pairingRefusal(watch, existing);
    }
    const pairId = existing?.pairId ?? (await this.createPair(watch, phone, signal));
    const created = !existing;
    if (existing?.state !== "active") {
      await this.activate(pairId, signal);
    }
    return {
      pairId,
      state: "active",
      connection: existing?.connection ?? "disconnected",
      phoneDeviceId: phone,
      created,
    };
  }

  private async validatePhone(phone: string, signal?: AbortSignal): Promise<void> {
    const devices = parseSimctlDeviceList(
      (await this.simctl.executeCommandArgs(["list", "devices", "--json"], undefined, signal))
        .stdout,
    );
    if (
      !Object.entries(devices.devices).some(
        ([runtime, entries]) =>
          runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
          entries.some((device) => device.udid === phone),
      )
    ) {
      throw new ActionableError(
        `No iOS-runtime simulator has UDID ${phone}. Pass an iPhone simulator UDID from listDeviceImages; boot it separately with startDevice platform ios.`,
      );
    }
  }

  private async createPair(watch: string, phone: string, signal?: AbortSignal): Promise<string> {
    try {
      const pairId = (
        await this.simctl.executeCommandArgs(
          simulatorPairArgs.pair(watch, phone),
          undefined,
          signal,
        )
      ).stdout.trim();
      if (!pairId) {
        throw new ActionableError(
          "simctl pair returned no pair ID; inspect the simulator pairs and retry.",
        );
      }
      this.owned.set(pairId, watch);
      return pairId;
    } catch (error) {
      if (isMaximumPairingError(errorMessage(error))) {
        throw pairingRefusal(
          watch,
          (await this.list(signal)).find((pair) => pair.watch.deviceId === watch),
        );
      }
      throw toActionableError(
        error,
        "Failed to pair Apple Watch; check simulator compatibility and retry",
      );
    }
  }

  private async activate(pairId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.simctl.executeCommandArgs(simulatorPairArgs.activate(pairId), undefined, signal);
    } catch (error) {
      if (!isAlreadyActiveError(errorMessage(error))) {
        throw toActionableError(error, `Failed to activate simulator pair ${pairId}`);
      }
      // simctl reports the desired active state as code 37; activation succeeded already.
      logger.debug(`Simulator pair ${pairId} is already active`);
    }
  }

  async refresh(pair: WatchPairResult, signal?: AbortSignal): Promise<WatchPairResult> {
    const current = (await this.list(signal)).find((entry) => entry.pairId === pair.pairId);
    if (!current) {
      throw new ActionableError(
        `Simulator pair ${pair.pairId} disappeared; retry startDevice with pairWithDeviceId.`,
      );
    }
    return { ...pair, state: current.state, connection: current.connection };
  }

  async unpairCreated(watch: string, signal?: AbortSignal): Promise<void> {
    for (const [id, owner] of this.owned) {
      if (owner !== watch) {
        continue;
      }
      try {
        await this.simctl.executeCommandArgs(simulatorPairArgs.unpair(id), undefined, signal);
        this.owned.delete(id);
      } catch (error) {
        logger.warn(
          `Could not unpair daemon-created simulator pair ${id}: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }
}
export function defaultSimulatorPairService(): SimulatorPairService {
  return new SimulatorPairService(new SimCtlClient());
}
