// Harness modules never import the product logger; typed failure messages are the trace.
import { join } from "node:path";
import { z } from "zod";
import type { PrivateDaemonCliDeps } from "./private-daemon";
import type { PrivateDaemonBatchOptions, PrivateDaemonSpec } from "./privateDaemonEnv";
import { androidDevices, iosDevices, definedEnv } from "./privateDaemonStatus";
import { errorMessage } from "../../src/utils/describeUnknownError";

const platformSchema = z.enum(["android", "ios"]);
const hostInventorySchema = z.union([z.array(z.string()), z.object({ unavailable: z.string() })]);
const baselineSchema = z.object({
  recordedAt: z.string().datetime().optional(),
  android: hostInventorySchema,
  ios: hostInventorySchema,
});
export type HostBaseline = z.infer<typeof baselineSchema>;
interface DeviceIdentity {
  deviceId: string;
  name: string;
  platform: "android" | "ios";
}
export function classifyDevice(
  device: DeviceIdentity,
  baseline: HostBaseline | undefined,
  protectedDevices: string[],
): { provenance: "preexisting" | "batch-booted" | "unknown"; protected: boolean } {
  const inventory = baseline?.[device.platform];
  const provenance = Array.isArray(inventory)
    ? inventory.includes(device.deviceId)
      ? "preexisting"
      : "batch-booted"
    : "unknown";
  return {
    provenance,
    protected: protectedDevices.includes(device.deviceId) || protectedDevices.includes(device.name),
  };
}
export function parseLsofPid(stdout: string): { pid: number | null; pidReason?: string } {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("p"));
  const pids = lines.map((line) => (/^p[1-9]\d*$/.test(line) ? Number(line.slice(1)) : NaN));
  const distinct = [...new Set(pids)];
  return distinct.length === 1 && Number.isSafeInteger(distinct[0])
    ? { pid: distinct[0] }
    : { pid: null, pidReason: "lsof did not report one distinct valid listener PID" };
}
// Pinned to consolePortFromSerial in EmulatorConsoleClient.ts, which directly imports the product logger.
function consolePort(deviceId: string): number | null {
  const match = /^emulator-(\d+)$/.exec(deviceId);
  const port = match ? Number(match[1]) : 0;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
async function devicePid(
  device: DeviceIdentity & { isVirtual: boolean },
  deps: PrivateDaemonCliDeps,
): Promise<{ pid: number | null; pidReason?: string }> {
  if (device.platform !== "android" || !device.isVirtual) {
    return { pid: null };
  }
  const port = consolePort(device.deviceId);
  if (port === null) {
    return { pid: null, pidReason: "not an Android emulator console serial" };
  }
  try {
    const result = await deps.runCapture(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      definedEnv(deps.env),
      5000,
    );
    return result.exitCode === 0
      ? parseLsofPid(result.stdout)
      : { pid: null, pidReason: result.stderr || `lsof exited ${result.exitCode}` };
  } catch (error) {
    // Optional PID evidence cannot fail inventory or authorize any device signal.
    return { pid: null, pidReason: errorMessage(error) };
  }
}
function baselinePath(batchDir: string): string {
  return join(batchDir, "shared/host-devices-at-start.json");
}
function snapshotPath(batchDir: string): string {
  return join(batchDir, "shared/devices-last.json");
}
async function hostIds(
  reader: () => Promise<unknown>,
  key: "deviceId" | "udid",
): Promise<z.infer<typeof hostInventorySchema>> {
  try {
    const section = await reader();
    const rows = z.array(z.record(z.unknown())).safeParse(section);
    if (rows.success) {
      return rows.data.map((row) => z.string().parse(row[key]));
    }
    const failure = z
      .object({ skipped: z.string().optional(), error: z.string().optional() })
      .parse(section);
    return { unavailable: failure.skipped ?? failure.error ?? "host inventory unavailable" };
  } catch (error) {
    // A failed host reader records unavailable evidence; starting the batch remains permitted.
    return { unavailable: errorMessage(error) };
  }
}
export async function recordHostBaseline(
  batchDir: string,
  deps: PrivateDaemonCliDeps,
): Promise<void> {
  const path = baselinePath(batchDir);
  if (deps.exists(path)) {
    return;
  }
  const recordedAt = new Date(deps.timer.now()).toISOString();
  const android = await hostIds(() => androidDevices(deps, 10000), "deviceId");
  const ios = await hostIds(() => iosDevices(deps, 10000), "udid");
  deps.mkdir(join(batchDir, "shared"), 0o700);
  // Recheck after the asynchronous readers: never overwrite an existing baseline.
  if (!deps.exists(path)) {
    deps.writeFile(path, JSON.stringify({ recordedAt, android, ios }));
  }
}
function readBaseline(batchDir: string, deps: PrivateDaemonCliDeps): HostBaseline | undefined {
  const path = baselinePath(batchDir);
  return deps.exists(path) ? baselineSchema.parse(JSON.parse(deps.readFile(path))) : undefined;
}
// The product toolEnvelopePayload helper imports its logger, so this module reads the same
// structuredContent/first JSON text precedence locally with zod.
// Field projection pinned to deviceDescriptionSchema in src/server/deviceDescription.ts.
// Importing deviceTools.ts would register tools; configured images have a null runtime deviceId.
const descriptionSchema = z.object({
  identity: z.object({ stableId: z.string() }),
  name: z.string(),
  platform: platformSchema,
  isVirtual: z.boolean(),
  runtime: z.object({
    deviceId: z.string().nullable(),
    lifecycle: z.object({
      state: z.enum(["configured", "booting", "booted", "shutting-down", "unavailable"]),
    }),
    poolStatus: z.enum(["idle", "assigned", "error"]).nullable().optional(),
    heldBy: z.enum(["managed_slot", "other_daemon"]).optional(),
  }),
});
const listSchema = z.object({ devices: z.array(descriptionSchema) });
const failureSchema = z
  .object({
    success: z.boolean().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    error: z
      .union([
        z.string(),
        z
          .object({
            code: z.union([z.string(), z.number()]).optional(),
            message: z.string().optional(),
          })
          .passthrough(),
      ])
      .optional(),
    message: z.string().optional(),
  })
  .passthrough();
const envelopeSchema = failureSchema.extend({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
    .optional(),
});
const wireSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
});
interface ToolReply {
  payload: unknown;
  refusal?: { code?: string | number; message: string };
}
function textPayload(content: z.infer<typeof envelopeSchema>["content"]): unknown {
  const text = content?.find((item) => item.type === "text" && item.text)?.text;
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // Plain-text MCP errors are legitimate; preserve their message as a typed payload.
    return { message: text };
  }
}
function refusalDetail(
  detail: z.infer<typeof failureSchema>,
  envelope: z.infer<typeof failureSchema>,
): NonNullable<ToolReply["refusal"]> {
  const nested = errorDetail(detail.error);
  const fallback = errorDetail(envelope.error);
  return {
    code: detail.code ?? nested?.code ?? envelope.code ?? fallback?.code,
    message:
      nested?.message ??
      detail.message ??
      fallback?.message ??
      envelope.message ??
      "tool refused request",
  };
}
function errorDetail(
  error: z.infer<typeof failureSchema>["error"],
): { code?: string | number; message?: string } | undefined {
  return typeof error === "string" ? { message: error } : error;
}
function toolReply(value: unknown): ToolReply {
  const wire = wireSchema.parse(value);
  if (!wire.success) {
    return {
      payload: undefined,
      refusal: { code: wire.code, message: wire.error ?? "daemon refused request" },
    };
  }
  const envelope = envelopeSchema.parse(wire.result);
  const payload = envelope.structuredContent ?? textPayload(envelope.content) ?? wire.result;
  const failure = failureSchema.safeParse(payload);
  if (
    envelope.isError ||
    envelope.success === false ||
    (failure.success && failure.data.success === false)
  ) {
    const detail = failure.success ? failure.data : envelope;
    return {
      payload,
      refusal: refusalDetail(detail, envelope),
    };
  }
  return { payload };
}
const deviceSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  platform: platformSchema,
  isVirtual: z.boolean(),
  seenByDaemons: z.array(z.string()),
  pid: z.number().int().positive().nullable(),
  pidReason: z.string().optional(),
  provenance: z.enum(["batch-booted", "preexisting", "unknown"]),
  protected: z.boolean(),
  poolStatus: z.enum(["idle", "assigned", "error"]).nullable().optional(),
  heldBy: z.enum(["managed_slot", "other_daemon"]).optional(),
});
type BatchDevice = z.infer<typeof deviceSchema>;
interface DeviceView {
  batchDir: string;
  protectedDevices: string[];
  baseline: {
    recordedAt?: string;
    android: "recorded" | "unavailable" | "missing";
    ios: "recorded" | "unavailable" | "missing";
  };
  daemons: Array<{ name: string; alive: boolean; error?: string }>;
  devices: BatchDevice[];
}
function baselineSummary(baseline: HostBaseline | undefined): DeviceView["baseline"] {
  const status = (platform: "android" | "ios") =>
    baseline === undefined
      ? "missing"
      : Array.isArray(baseline[platform])
        ? "recorded"
        : "unavailable";
  return {
    ...(baseline?.recordedAt ? { recordedAt: baseline.recordedAt } : {}),
    android: status("android"),
    ios: status("ios"),
  };
}
function mergeRows(
  rows: z.infer<typeof listSchema>["devices"],
  name: string,
  devices: Map<string, BatchDevice>,
  baseline: HostBaseline | undefined,
  protectedDevices: string[],
): void {
  for (const row of rows) {
    const deviceId = row.runtime.deviceId;
    if (
      !deviceId?.trim() ||
      !["booting", "booted", "shutting-down"].includes(row.runtime.lifecycle.state)
    ) {
      continue;
    }
    const previous = devices.get(deviceId);
    if (previous) {
      previous.seenByDaemons.push(name);
      previous.protected ||= protectedDevices.includes(row.name);
      // Conflicting identities cannot authorize shutdown from either daemon's label.
      if (
        previous.name !== row.name ||
        previous.platform !== row.platform ||
        previous.isVirtual !== row.isVirtual
      ) {
        previous.provenance = "unknown";
      }
      continue;
    }
    const device = { deviceId, name: row.name, platform: row.platform, isVirtual: row.isVirtual };
    devices.set(deviceId, {
      ...device,
      seenByDaemons: [name],
      pid: null,
      ...classifyDevice(device, baseline, protectedDevices),
      poolStatus: row.runtime.poolStatus,
      heldBy: row.runtime.heldBy,
    });
  }
}
async function buildDeviceView(
  options: PrivateDaemonBatchOptions,
  specs: PrivateDaemonSpec[],
  timeoutMs: number,
  deps: PrivateDaemonCliDeps,
): Promise<DeviceView> {
  const baseline = readBaseline(options.batchDir, deps);
  const protectedDevices = options.protectedDevices ?? [];
  const view: DeviceView = {
    batchDir: options.batchDir,
    protectedDevices,
    baseline: baselineSummary(baseline),
    daemons: [],
    devices: [],
  };
  const devices = new Map<string, BatchDevice>();
  for (const spec of specs) {
    try {
      const reply = toolReply(
        await deps.requestSocket(spec.socketPath, {
          method: "tools/call",
          params: { name: "listDevices", arguments: {} },
          timeoutMs,
        }),
      );
      view.daemons.push({
        name: spec.name,
        alive: true,
        ...(reply.refusal ? { error: reply.refusal.message } : {}),
      });
      if (!reply.refusal) {
        mergeRows(
          listSchema.parse(reply.payload).devices,
          spec.name,
          devices,
          baseline,
          protectedDevices,
        );
      }
    } catch (error) {
      // A dead socket or invalid inventory is diagnostic evidence, not a reason to lose other views.
      const existing = view.daemons.find((daemon) => daemon.name === spec.name);
      if (existing) {
        existing.error = errorMessage(error);
      } else {
        view.daemons.push({ name: spec.name, alive: false, error: errorMessage(error) });
      }
    }
  }
  for (const device of devices.values()) {
    Object.assign(device, await devicePid(device, deps));
  }
  view.devices = [...devices.values()];
  return view;
}
export interface BatchDevicesCommand {
  op: "devices" | "shutdown-devices";
  batchDir: string;
  daemon?: number;
  extraFlags: string[];
  timeoutMs: number;
  deviceSelectors?: string[];
  dryRun?: boolean;
}
type DeviceOutcome =
  | "stopped"
  | "refused"
  | "failed"
  | "timeout"
  | "protected"
  | "not-batch-booted"
  | "not-found"
  | "dry-run"
  | "daemon-dead";
interface DeviceResult extends Omit<DeviceIdentity, "platform"> {
  platform: DeviceIdentity["platform"] | null;
  pid: number | null;
  outcome: DeviceOutcome;
  daemon?: string;
  code?: string | number;
  message?: string;
}
function refusal(
  device: BatchDevice,
  protectedDevices: string[],
): Pick<DeviceResult, "outcome" | "message"> | undefined {
  if (
    device.protected ||
    protectedDevices.includes(device.deviceId) ||
    protectedDevices.includes(device.name)
  ) {
    return { outcome: "protected" };
  }
  if (!device.name && protectedDevices.length) {
    return {
      outcome: "protected",
      message: "Device name could not be read; cannot check it against the protected list.",
    };
  }
  if (!device.isVirtual || device.provenance !== "batch-booted") {
    return { outcome: "not-batch-booted" };
  }
  return undefined;
}
function resultRow(
  device: BatchDevice,
  result: Pick<DeviceResult, "outcome" | "message">,
): DeviceResult {
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    pid: device.pid,
    ...result,
  };
}
function selectedDevices(
  view: DeviceView,
  selectors: string[],
): { devices: BatchDevice[]; missing: DeviceResult[] } {
  if (!selectors.length) {
    return {
      devices: view.devices.filter(
        (device) => device.isVirtual && device.provenance === "batch-booted" && !device.protected,
      ),
      missing: [],
    };
  }
  const devices = new Set<BatchDevice>();
  const missing: DeviceResult[] = [];
  for (const selector of selectors) {
    const matches = view.devices.filter(
      (device) => device.deviceId === selector || device.name === selector,
    );
    for (const device of matches) {
      devices.add(device);
    }
    if (!matches.length) {
      missing.push({
        deviceId: selector,
        name: selector,
        platform: null,
        pid: null,
        outcome: "not-found",
        message: "No selected daemon lists this device.",
      });
    }
  }
  return { devices: [...devices], missing };
}
function rejectionOutcome(error: unknown): "timeout" | "failed" {
  const detail = z.object({ code: z.union([z.string(), z.number()]).optional() }).safeParse(error);
  return (detail.success && String(detail.data.code).toUpperCase().includes("TIMEOUT")) ||
    /timed?\s*out|timeout/i.test(errorMessage(error))
    ? "timeout"
    : "failed";
}
async function killDevice(
  device: BatchDevice,
  spec: PrivateDaemonSpec,
  timeoutMs: number,
  deps: PrivateDaemonCliDeps,
): Promise<DeviceResult> {
  const row = resultRow(device, { outcome: "stopped" });
  row.daemon = spec.name;
  try {
    const reply = toolReply(
      await deps.requestSocket(spec.socketPath, {
        method: "tools/call",
        params: {
          name: "killDevice",
          arguments: {
            device: { name: device.name, deviceId: device.deviceId, platform: device.platform },
          },
        },
        timeoutMs,
      }),
    );
    return reply.refusal ? { ...row, outcome: "refused", ...reply.refusal } : row;
  } catch (error) {
    // Never retry a possibly completed device mutation; report the transport failure to the operator.
    return { ...row, outcome: rejectionOutcome(error), message: errorMessage(error) };
  }
}
async function shutdownDevices(
  view: DeviceView,
  specs: PrivateDaemonSpec[],
  command: BatchDevicesCommand,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const selected = selectedDevices(view, command.deviceSelectors ?? []);
  const results = selected.missing;
  for (const device of selected.devices) {
    const denied = refusal(device, view.protectedDevices);
    const spec = specs.find(
      (spec) =>
        device.seenByDaemons.includes(spec.name) &&
        view.daemons.some((daemon) => daemon.name === spec.name && daemon.alive),
    );
    if (denied) {
      results.push(resultRow(device, denied));
    } else if (command.dryRun) {
      results.push(resultRow(device, { outcome: "dry-run" }));
    } else if (spec) {
      results.push(await killDevice(device, spec, command.timeoutMs, deps));
    } else {
      results.push(resultRow(device, { outcome: "daemon-dead" }));
    }
  }
  deps.log(JSON.stringify({ results }));
  return results.every((result) => result.outcome === "stopped" || result.outcome === "dry-run")
    ? 0
    : 1;
}
const snapshotSchema = z.object({ batchDir: z.string(), devices: z.array(deviceSchema) });
async function deadDaemonFallback(
  view: DeviceView,
  specs: PrivateDaemonSpec[],
  command: BatchDevicesCommand,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const path = snapshotPath(view.batchDir);
  if (!deps.exists(path)) {
    deps.log(
      JSON.stringify({
        results: [],
        message: "No selected daemon answered and no devices-last.json snapshot is available.",
      }),
    );
    return 1;
  }
  const snapshot = snapshotSchema.parse(JSON.parse(deps.readFile(path)));
  if (snapshot.batchDir !== view.batchDir) {
    throw new Error("Device snapshot belongs to a different batch.");
  }
  const selected = selectedDevices(
    {
      ...view,
      devices: snapshot.devices.filter((device) =>
        specs.some((spec) => device.seenByDaemons.includes(spec.name)),
      ),
    },
    command.deviceSelectors ?? [],
  );
  const results = selected.missing;
  for (const device of selected.devices) {
    if (refusal(device, view.protectedDevices)) {
      continue;
    }
    Object.assign(device, await devicePid(device, deps));
    results.push(
      resultRow(device, {
        outcome: "daemon-dead",
        message: `No daemon can stop this device. After checking its name against the protected list, stop it by PID${device.platform === "ios" ? ` or xcrun simctl shutdown ${device.deviceId}` : ""}.`,
      }),
    );
  }
  deps.log(JSON.stringify({ results }));
  return 1;
}
export async function privateDaemonDevices(
  command: BatchDevicesCommand,
  options: PrivateDaemonBatchOptions,
  specs: PrivateDaemonSpec[],
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const view = await buildDeviceView(options, specs, command.timeoutMs, deps);
  if (!view.daemons.some((daemon) => daemon.alive)) {
    return deadDaemonFallback(view, specs, command, deps);
  }
  deps.mkdir(join(options.batchDir, "shared"), 0o700);
  deps.writeFile(snapshotPath(options.batchDir), JSON.stringify(view));
  if (command.op === "shutdown-devices") {
    return shutdownDevices(view, specs, command, deps);
  }
  deps.log(JSON.stringify(view));
  return 0;
}
