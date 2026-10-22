import { join, resolve } from "node:path";
import { z } from "zod";
import { isSessionBrokerDeviceName } from "../../src/daemon/sessionBroker/deviceNaming";
import type { Timer } from "../../src/utils/SystemTimer";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { readBrokerProtectedDevices } from "./brokerClientFiles";
import { BrokerTransportError, type BrokerDaemonClient } from "./brokerDaemonClient";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { logger } from "../../src/utils/logger";
import {
  matchesProtection,
  nameEvidenceMissing,
  type DeviceIdentity,
} from "./privateDaemonDeviceEvidence";

export const brokerNativeDeviceSchema = z.object({
  name: z.string().min(1),
  deviceId: z.string().min(1),
  platform: z.enum(["android", "ios"]),
});
const grantSchema = z.object({
  outcome: z.literal("ready"),
  requestId: z.string().min(1),
  sessionUuid: z.string().min(1),
});
export const brokerLedgerEntrySchema = z.object({
  batchDir: z.string(),
  client: z.string().regex(/^[a-z0-9-]{1,32}$/),
  requestId: z.string().min(1),
  sessionUuid: z.string().min(1),
  at: z.number().finite(),
  kind: z.enum(["acquired", "info", "released", "absent", "pooled", "leaked"]),
  device: brokerNativeDeviceSchema.optional(),
  absence: z.literal("not-verifiable").optional(),
});
export type BrokerLedgerEntry = z.infer<typeof brokerLedgerEntrySchema>;
export interface BrokerLedgerFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  mkdir(path: string): void;
  /** One synchronous O_APPEND write per complete JSONL record; never read/replace the file. */
  appendFile(path: string, text: string): void;
}
export interface LedgerDevicesView {
  devices: Array<Pick<DeviceIdentity, "name" | "deviceId" | "platform">>;
  daemons: Array<{ alive: boolean; error?: string }>;
}
export class BrokerDeviceInfoRefusedError extends Error {
  constructor(
    readonly device: z.infer<typeof brokerNativeDeviceSchema>,
    reason: string,
  ) {
    super(`Native device info refused: ${reason}.`);
    this.name = "BrokerDeviceInfoRefusedError";
  }
}
/** The acquired event durably records a ready init.json.session, including archived attempts. */
export class BrokerDeviceLedger {
  readonly path: string;
  readonly batchDir: string;
  private readonly rows: BrokerLedgerEntry[] = [];
  constructor(
    private readonly options: {
      batchDir: string;
      fs: BrokerLedgerFs;
      timer: Timer;
      tokenFor?: (client: string, requestId: string) => string;
    },
  ) {
    this.batchDir = resolve(options.batchDir);
    this.path = join(this.batchDir, "evidence/ledger.jsonl");
    this.reload();
  }
  /** Other proxy processes append independently; every read must use the durable ledger. */
  private reload(): void {
    const rows: BrokerLedgerEntry[] = [];
    const { fs } = this.options;
    if (fs.exists(this.path)) {
      const bytes = fs.readFile(this.path);
      if (bytes && !bytes.endsWith("\n")) {
        throw new Error("Incomplete broker ledger record; refusing ownership inference.");
      }
      for (const line of bytes.split("\n").filter(Boolean)) {
        const entry = brokerLedgerEntrySchema.parse(JSON.parse(line));
        if (entry.batchDir !== this.batchDir) {
          throw new Error("Broker ledger belongs to another batch.");
        }
        if (
          entry.kind !== "acquired" &&
          ((!entry.device && entry.kind !== "released") ||
            !rows.some((row) => row.kind === "acquired" && sameGrant(row, entry)))
        ) {
          throw new Error("Broker ledger device has no ready batch grant.");
        }
        if (entry.absence && (entry.kind !== "released" || entry.device)) {
          throw new Error("Unverifiable absence is only valid for an info-less released grant.");
        }
        if (
          entry.kind !== "acquired" ||
          !rows.some((row) => row.kind === "acquired" && sameGrant(row, entry))
        ) {
          rows.push(entry);
        }
      }
    }
    this.rows.splice(0, this.rows.length, ...rows);
  }
  get entries(): readonly BrokerLedgerEntry[] {
    this.reload();
    return [...this.rows];
  }
  hasGrant(identity: Pick<BrokerLedgerEntry, "client" | "requestId" | "sessionUuid">): boolean {
    this.reload();
    return this.rows.some((row) => row.kind === "acquired" && sameGrant(row, identity));
  }
  acquired(client: string, init: unknown): BrokerLedgerEntry {
    this.reload();
    const { session } = z.object({ session: grantSchema }).parse(init);
    const identity = { client, requestId: session.requestId, sessionUuid: session.sessionUuid };
    if (
      this.rows.some(
        (row) =>
          row.kind === "acquired" &&
          (row.sessionUuid === identity.sessionUuid || row.requestId === identity.requestId) &&
          !sameGrant(row, identity),
      )
    ) {
      throw new Error("Broker grant identity conflicts with an existing batch session.");
    }
    const previous = this.rows.find((row) => row.kind === "acquired" && sameGrant(row, identity));
    return previous ?? this.append({ ...identity, kind: "acquired" });
  }
  info(client: string, init: unknown, info: unknown): BrokerLedgerEntry {
    const { session } = z.object({ session: grantSchema }).parse(init);
    const binding = z
      .object({ sessionId: z.string(), nativeDevice: brokerNativeDeviceSchema })
      .parse(info);
    if (binding.sessionId !== session.sessionUuid) {
      throw new Error("Native device info does not match the ready session.");
    }
    if (
      matchesProtection(
        binding.nativeDevice,
        readBrokerProtectedDevices(this.batchDir, this.options.fs),
      )
    ) {
      throw new BrokerDeviceInfoRefusedError(binding.nativeDevice, "protected device");
    }
    if (!isSessionBrokerDeviceName(binding.nativeDevice.name)) {
      throw new BrokerDeviceInfoRefusedError(
        binding.nativeDevice,
        "device name is not product-owned",
      );
    }
    const grant = this.acquired(client, init);
    const previous = this.devices().find((row) => sameGrant(row, grant));
    if (previous && JSON.stringify(previous.device) !== JSON.stringify(binding.nativeDevice)) {
      throw new Error("Session native device identity changed; refusing ledger rebind.");
    }
    return this.append({ ...grant, device: binding.nativeDevice, kind: "info" });
  }
  record(
    kind: "released" | "absent" | "pooled" | "leaked",
    device: BrokerLedgerEntry,
  ): BrokerLedgerEntry {
    if (!this.hasGrant(device) || (!device.device && kind !== "released")) {
      throw new Error("Device event requires a ready batch grant and native identity.");
    }
    return this.append({
      ...device,
      kind,
      ...(!device.device && kind === "released" ? { absence: "not-verifiable" as const } : {}),
    });
  }
  devices(): BrokerLedgerEntry[] {
    this.reload();
    const devices = new Map<string, BrokerLedgerEntry>();
    for (const row of this.rows) {
      if (row.kind === "info" && row.device) {
        devices.set(JSON.stringify([row.sessionUuid, row.device.name]), row);
      }
    }
    return [...devices.values()];
  }
  hasEvent(device: BrokerLedgerEntry, kind: BrokerLedgerEntry["kind"]): boolean {
    this.reload();
    return this.rows.some(
      (row) =>
        row.kind === kind &&
        sameGrant(row, device) &&
        (kind === "released" || row.device?.name === device.device?.name),
    );
  }
  releaseComplete(grant: BrokerLedgerEntry): boolean {
    const device = this.devices().find((row) => sameGrant(row, grant));
    return (
      this.hasEvent(grant, "released") &&
      (device
        ? this.hasEvent(device, "absent") || this.hasEvent(device, "pooled")
        : this.entries.some(
            (row) =>
              sameGrant(row, grant) && row.kind === "released" && row.absence === "not-verifiable",
          ))
    );
  }
  token(device: BrokerLedgerEntry): string {
    const token = this.options.tokenFor?.(device.client, device.requestId);
    if (!token) {
      throw new Error("Release assertion requires the client's stored owner token.");
    }
    return token;
  }
  private append(input: Omit<BrokerLedgerEntry, "at" | "batchDir">): BrokerLedgerEntry {
    this.reload();
    const row = brokerLedgerEntrySchema.parse({
      ...input,
      batchDir: this.batchDir,
      at: this.options.timer.now(),
    });
    this.options.fs.mkdir(join(this.batchDir, "evidence"));
    this.options.fs.appendFile(this.path, `${JSON.stringify(row)}\n`);
    this.rows.push(row);
    return row;
  }
}
function sameGrant(
  a: Pick<BrokerLedgerEntry, "client" | "requestId" | "sessionUuid">,
  b: Pick<BrokerLedgerEntry, "client" | "requestId" | "sessionUuid">,
): boolean {
  return a.client === b.client && a.requestId === b.requestId && a.sessionUuid === b.sessionUuid;
}
export function ledgerDevice(
  device: DeviceIdentity,
  ledger: BrokerDeviceLedger,
): BrokerLedgerEntry | undefined {
  const matches = ledger
    .devices()
    .filter(
      (row) =>
        row.device?.name === device.name &&
        row.device.deviceId === device.deviceId &&
        row.device.platform === device.platform &&
        !ledger.hasEvent(row, "released"),
    );
  return matches.length === 1 ? matches[0] : undefined;
}
export function classifyDevice(
  device: DeviceIdentity,
  ledger: BrokerDeviceLedger,
  protectedList: string[],
): "allowed" | "foreign" | "protected" {
  if (matchesProtection(device, protectedList)) {
    return "protected";
  }
  return isSessionBrokerDeviceName(device.name) && ledgerDevice(device, ledger)
    ? "allowed"
    : "foreign";
}
function present(row: BrokerLedgerEntry, view: Pick<LedgerDevicesView, "devices">): boolean {
  // A serial can be reused after destruction. Native name + session is the durable identity.
  const native = row.device;
  return (
    !!native &&
    view.devices.some(
      (device) =>
        device.platform === native.platform &&
        (device.name === native.name ||
          (nameEvidenceMissing(device) && device.deviceId === native.deviceId)),
    )
  );
}
export function leakReport(
  ledger: BrokerDeviceLedger,
  devicesView: Pick<LedgerDevicesView, "devices">,
): BrokerLedgerEntry[] {
  const devices = ledger.devices();
  return devices.filter((row) => {
    const latest = devices.findLast(
      (grant) =>
        grant.device?.name === row.device?.name && grant.device?.platform === row.device?.platform,
    )!;
    return (
      ledger.hasEvent(row, "released") &&
      present(row, devicesView) &&
      !(ledger.hasEvent(row, "pooled") && ledger.hasEvent(latest, "pooled"))
    );
  });
}
/** Join released status with healthy inventory proving absence or a reusable pooled device. */
export async function assertReleasedAndAbsent(options: {
  ledger: BrokerDeviceLedger;
  devicesView(): Promise<LedgerDevicesView>;
  daemonClient: BrokerDaemonClient;
  timer: Timer;
  budgetMs: number;
  log?: (message: string) => void;
}): Promise<void> {
  const { ledger, timer, daemonClient } = options;
  if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0) {
    throw new Error("Absence budget must be positive.");
  }
  let active = true;
  let completed = false;
  let lastView: LedgerDevicesView | undefined;
  if (!ledger.devices().length) {
    throw new Error("No native device info in ledger; absence cannot be verified.");
  }
  const deadline = timer.now() + options.budgetMs;
  try {
    await raceWithDeadline(
      async () => {
        while (active && timer.now() < deadline) {
          const confirmed = new Map<string, SessionBrokerResult>();
          const devices = ledger.devices();
          let transportFailed = false;
          for (const device of devices) {
            if (!active || timer.now() >= deadline) {
              return;
            }
            let status: SessionBrokerResult | undefined;
            try {
              status = await daemonClient.status(device.requestId, ledger.token(device));
            } catch (error) {
              if (!(error instanceof BrokerTransportError)) {
                throw error;
              }
              if (!active) {
                return;
              }
              // Restart transport loss is not a receipt; leave this grant unconfirmed for this pass.
              const message = `Broker status transport retry for ${device.client}: ${errorMessage(error)}`;
              if (options.log) {
                options.log(message);
              } else {
                logger.debug(message, error);
              }
              transportFailed = true;
              continue;
            }
            if (!active) {
              return;
            }
            if (
              status?.sessionUuid === device.sessionUuid &&
              status.requestId === device.requestId &&
              status.outcome === "released" &&
              !status.cleanupPending
            ) {
              confirmed.set(device.sessionUuid, status);
              if (!ledger.hasEvent(device, "released")) {
                ledger.record("released", device);
              }
            }
          }
          const view = await options.devicesView();
          if (!active) {
            return;
          }
          const healthy =
            view.daemons.length > 0 &&
            view.daemons.every((daemon) => daemon.alive && daemon.error === undefined);
          if (healthy) {
            lastView = view;
            const satisfied = new Set<string>();
            for (const device of devices) {
              if (!confirmed.has(device.sessionUuid)) {
                continue;
              }
              if (!present(device, view)) {
                satisfied.add(device.sessionUuid);
                if (!ledger.hasEvent(device, "absent")) {
                  ledger.record("absent", device);
                }
                continue;
              }
              const latest = devices.findLast(
                (grant) =>
                  grant.device?.name === device.device?.name &&
                  grant.device?.platform === device.device?.platform,
              )!;
              const reset = confirmed.get(latest.sessionUuid)?.timing?.reset;
              if (
                reset &&
                reset.retired !== true &&
                (reset.outcome === "clean" || reset.outcome.startsWith("fallback:"))
              ) {
                satisfied.add(device.sessionUuid);
                if (!ledger.hasEvent(device, "pooled")) {
                  ledger.record("pooled", device);
                }
              }
            }
            if (
              devices.every(
                (device) => confirmed.has(device.sessionUuid) && satisfied.has(device.sessionUuid),
              )
            ) {
              completed = true;
              return;
            }
            if (timer.now() >= deadline) {
              break;
            }
          }
          await timer.sleep(
            Math.min(transportFailed ? 1000 : 250, Math.max(0, deadline - timer.now())),
          );
        }
        throw new Error("Broker release/absence could not be verified.");
      },
      { timer, timeoutMs: options.budgetMs, label: "Broker release and native absence" },
    );
  } finally {
    active = false;
    if (!completed && lastView) {
      for (const device of leakReport(ledger, lastView)) {
        ledger.record("leaked", device);
      }
    }
  }
}
