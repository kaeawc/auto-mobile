import "./harnessLogSink";
import { join, resolve } from "node:path";
import { z } from "zod";
import { isSessionBrokerDeviceName } from "../../src/daemon/sessionBroker/deviceNaming";
import { parseSessionBrokerHostConfig } from "../../src/daemon/sessionBroker/hostConfig";
import { readToolEnvelopePayload } from "../../src/server/toolEnvelopePayload";
import { readBrokerClients, readBrokerIdentity, resolveBrokerClient } from "./brokerClientFiles";
import { BrokerDeviceLedger, type LedgerDevicesView } from "./brokerDeviceLedger";
import {
  createFrameBrokerDaemonClient,
  parseBrokerResult,
  type BrokerDaemonClient,
} from "./brokerDaemonClient";
import { bootGate, bootGateOptions } from "./bootGate";
import { privateHarnessEnvRefusal } from "./harnessEnv";
import { matchesProtection } from "./privateDaemonDeviceEvidence";
import {
  privateClientEnvironment,
  privateDaemonBatchRefusal,
  privatePathRefusal,
} from "./privateDaemonEnv";
import { createPrivateDaemonControl } from "./privateDaemonControl";
import {
  createPrivateDaemonDeps,
  readPrivateBatch,
  runPrivateDaemonCommand,
  type PrivateDaemonCliDeps,
} from "./private-daemon";
import {
  createProxySessionDeps,
  parseProxySessionArgs,
  runProxySessionCommand,
  type ProxySessionDeps,
} from "./proxy-session";
import type { BrokerScenarioClient, BrokerScenarioContext } from "./brokerScenarios";

export interface BrokerLiveAdapterOptions {
  maxDevices?: number;
  clients?: string[];
}
export interface BrokerLiveAdapterDeps {
  daemon: PrivateDaemonCliDeps;
  proxy: ProxySessionDeps;
  daemonClient?: BrokerDaemonClient;
  /** Test seam: production uses only the private daemon's read-only inventory. */
  devicesView?: () => Promise<LedgerDevicesView>;
  proxyCommand?: (argv: string[]) => Promise<{ code: number; output: string }>;
}
/** Validate canonical batch derivation before any socket, process, or device operation. */
export function assertPrivateBrokerBatch(
  batchDir: string,
  deps: PrivateDaemonCliDeps,
  maxDevices = 2,
) {
  for (const path of [
    batchDir,
    join(batchDir, "evidence"),
    join(batchDir, "sessions"),
    join(batchDir, "broker/host-config.json"),
    join(batchDir, "broker/clients.json"),
  ]) {
    const refusal = privatePathRefusal(path, deps.host);
    if (refusal) {
      throw new Error(refusal);
    }
  }
  const batch = readPrivateBatch(resolve(batchDir), deps);
  const refusal = privateDaemonBatchRefusal(batch.specs, batch.options, deps.host);
  if (refusal) {
    throw new Error(refusal);
  }
  if (!batch.broker || batch.specs.length !== 1) {
    throw new Error("Broker acceptance requires exactly one PRIVATE broker batch daemon.");
  }
  const spec = batch.specs[0];
  const envRefusal = privateHarnessEnvRefusal(spec.env, deps.host);
  if (envRefusal) {
    throw new Error(envRefusal);
  }
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 4) {
    throw new Error("--max-devices must be an integer from 1 to 4.");
  }
  const host = parseSessionBrokerHostConfig(
    JSON.parse(deps.readFile(join(batchDir, "broker/host-config.json"))),
  );
  const { totalDeviceCap, sessionCap } = host.limits;
  if (
    totalDeviceCap === undefined ||
    sessionCap === undefined ||
    totalDeviceCap < 1 ||
    totalDeviceCap > maxDevices ||
    sessionCap < totalDeviceCap ||
    host.limits.idlePoolCap !== 0 ||
    host.reuseCleanDevices
  ) {
    throw new Error(
      "Broker acceptance requires positive capacity <= --max-devices, sessionCap >= totalDeviceCap, idlePoolCap 0 and reuseCleanDevices false.",
    );
  }
  return { batch, spec, host, totalDeviceCap };
}
export async function createBrokerLiveContext(
  batchDir: string,
  evidence: BrokerScenarioContext["fs"],
  options: BrokerLiveAdapterOptions = {},
  injected?: BrokerLiveAdapterDeps,
): Promise<{ context: BrokerScenarioContext; close(): Promise<void> }> {
  batchDir = resolve(batchDir);
  const daemon = injected?.daemon ?? (await createPrivateDaemonDeps());
  const { batch, spec, totalDeviceCap } = assertPrivateBrokerBatch(
    batchDir,
    daemon,
    options.maxDevices,
  );
  const baseProxy = injected?.proxy ?? createProxySessionDeps();
  const proxy = { ...baseProxy, env: privateClientEnvironment(baseProxy.env, spec.env) };
  const daemonClient =
    injected?.daemonClient ??
    createFrameBrokerDaemonClient({
      socketPath: spec.socketPath,
      timer: proxy.timer,
      ids: proxy.ids,
    });
  const names = options.clients ?? readBrokerClients(batchDir, proxy);
  if (!names.length || new Set(names).size !== names.length) {
    throw new Error("Select unique batch clients.");
  }
  const clients: BrokerScenarioClient[] = names.map((name) => {
    const file = resolveBrokerClient(batchDir, name, proxy);
    const tokenPath = join(file.dir, "owner-token");
    return {
      name,
      config: file.initial,
      token: proxy.exists(tokenPath) ? proxy.readFile(tokenPath) : "",
    };
  });
  const ledger = new BrokerDeviceLedger({
    batchDir,
    fs: proxy,
    timer: proxy.timer,
    tokenFor: (name) => proxy.readFile(join(batchDir, "sessions", name, "owner-token")),
  });
  for (const grant of ledger.entries.filter((row) => row.kind === "acquired")) {
    if (!ledger.releaseComplete(grant)) {
      throw new Error(
        "Previous broker grant lacks a verified release receipt/native absence; run broker-batch down first.",
      );
    }
  }
  // Never take ownership of an existing driver. The caller must finish its prior run first.
  for (const name of readBrokerClients(batchDir, proxy)) {
    const path = join(batchDir, "sessions", name, "driver.pid");
    if (proxy.exists(path) && proxy.isPidAlive(Number(proxy.readFile(path)))) {
      throw new Error("A batch client driver is still alive; close it before broker acceptance.");
    }
  }
  const started = new Set<string>();
  const secrets = new Set(clients.map((c) => c.token).filter(Boolean));
  const command =
    injected?.proxyCommand ??
    (async (argv: string[]) => {
      const parsed = parseProxySessionArgs([
        ...argv,
        ...(["call", "read", "tools", "resources", "subscribe", "close"].includes(argv[0])
          ? ["--full"]
          : []),
      ]);
      if ("error" in parsed || "help" in parsed) {
        throw new Error("Invalid internal broker proxy command.");
      }
      let output = "";
      const code = await runProxySessionCommand(parsed, {
        ...proxy,
        flush: async (text) => {
          output += text;
        },
      });
      return { code, output };
    });
  const checked = async (argv: string[]) => {
    const reply = await command(argv);
    if (reply.code !== 0) {
      throw new Error(`Broker proxy ${argv[0]} failed: ${reply.output}`);
    }
    return reply.output;
  };
  const devicesView =
    injected?.devicesView ??
    (async (): Promise<LedgerDevicesView> => {
      const response = await daemon.requestSocket(spec.socketPath, {
        method: "tools/call",
        params: { name: "listDevices", arguments: {} },
        timeoutMs: 5000,
      });
      if (!response.success) {
        throw new Error("Private broker inventory unavailable.");
      }
      const envelope = z
        .object({
          isError: z.boolean().optional(),
          structuredContent: z.record(z.unknown()).optional(),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
        })
        .parse(response.result);
      if (envelope.isError) {
        throw new Error("Private broker inventory refused.");
      }
      const payload = readToolEnvelopePayload(envelope);
      const inventory = z
        .object({
          devices: z.array(
            z.object({
              name: z.string(),
              platform: z.enum(["android", "ios"]),
              runtime: z.object({ deviceId: z.string().nullable() }),
            }),
          ),
        })
        .parse(payload?.payload);
      return {
        daemons: [{ alive: true }],
        devices: inventory.devices.flatMap((d) =>
          d.runtime.deviceId
            ? [{ name: d.name, platform: d.platform, deviceId: d.runtime.deviceId }]
            : [],
        ),
      };
    });
  const closeClient = async (c: BrokerScenarioClient) => {
    if (!started.has(c.name)) {
      return;
    }
    await checked(["close", "--client", c.name]);
    started.delete(c.name);
  };
  const context: BrokerScenarioContext = {
    batchDir,
    clients,
    daemonClient,
    ledger,
    timer: proxy.timer,
    ids: proxy.ids,
    fs: {
      ...evidence,
      writeFile: (path, text) => {
        for (const token of secrets) {
          text = text.replaceAll(JSON.stringify(token).slice(1, -1), "[REDACTED]");
        }
        evidence.writeFile(path, text);
      },
    },
    maxDevices: options.maxDevices ?? 2,
    prepare: async () => {
      throw new Error("Live broker acquisition requires an owned proxy.");
    },
    preflight: async () =>
      (await runPrivateDaemonCommand({ op: "preflight", batchDir, strict: true }, daemon)) === 0,
    probe: async () =>
      (await proxy.probeDaemonSocket(spec.socketPath, { requireCapability: "session-broker/v1" }))
        .alive,
    privateDaemon: createPrivateDaemonControl(batchDir, daemon),
    record: async (_operation, _request, action) => action(),
    deviceOps: {
      totalDeviceCap,
      bootGate: async (name, permits, action) => {
        const parsed = bootGateOptions(
          { "--batch-dir": batchDir, "--role": name, "--max-concurrent": String(permits) },
          ["broker-acquire"],
        );
        if ("error" in parsed) {
          throw new Error(parsed.error);
        }
        let value: Awaited<ReturnType<typeof action>> | undefined;
        const code = await bootGate(parsed, {
          ...daemon,
          runCommand: async () => {
            value = await action();
            return { exitCode: 0 };
          },
        });
        if (code !== 0) {
          throw new Error("Broker acquisition boot-gate refused.");
        }
        return value!;
      },
      acquire: async (c, mode) => {
        started.add(c.name); // Include partially launched drivers in cleanup.
        const argv = ["up", "--client", c.name, "--init-timeout-ms", "1500000"];
        if (mode.resume) {
          argv.push("--resume");
        } else {
          argv.push(
            "--request",
            JSON.stringify({
              ...c.config,
              executionOwnerPid: undefined,
              executionOwnerStartIdentity: undefined,
            }),
          );
        }
        if (mode.disposableOwner) {
          argv.push("--owner", "disposable");
        }
        const reply = await command(argv);
        const identity = readBrokerIdentity(resolveBrokerClient(batchDir, c.name, proxy), proxy);
        c.config = identity.config;
        c.token = identity.token;
        secrets.add(c.token);
        const stored = z
          .object({ session: z.unknown() })
          .parse(JSON.parse(proxy.readFile(join(batchDir, "sessions", c.name, "init.json"))));
        const init = { session: parseBrokerResult(stored.session, c.config.requestId) };
        if (reply.code > 1 || !["ready", "failed"].includes(init.session.outcome)) {
          throw new Error("Broker acquisition failed before a terminal initialize.");
        }
        if (init.session.outcome === "ready") {
          const info = z
            .object({
              nativeDevice: z.object({
                name: z.string(),
                deviceId: z.string(),
                platform: z.enum(["android", "ios"]),
              }),
            })
            .parse(await daemonClient.info(init.session.sessionUuid!));
          if (matchesProtection(info.nativeDevice, batch.options.protectedDevices ?? [])) {
            throw new Error("Broker granted a protected device.");
          }
          if (!isSessionBrokerDeviceName(info.nativeDevice.name)) {
            throw new Error("Broker granted a device whose name is not a broker device name.");
          }
        }
        return init.session;
      },
      observe: async (c) => {
        const init = z
          .object({
            session: z.object({ outcome: z.literal("ready"), sessionUuid: z.string().min(1) }),
          })
          .parse(JSON.parse(proxy.readFile(join(batchDir, "sessions", c.name, "init.json"))));
        const output = await checked([
          "call",
          "observe",
          JSON.stringify({ sessionUuid: init.session.sessionUuid }),
          "--client",
          c.name,
        ]);
        const response = z
          .object({ ok: z.literal(true), result: z.object({ isError: z.boolean().optional() }) })
          .parse(JSON.parse(output));
        if (response.result.isError) {
          throw new Error(`Broker observe refused: ${output}`);
        }
      },
      tools: async (c) => {
        const output = await checked(["tools", "--client", c.name]);
        return z
          .object({ result: z.object({ tools: z.array(z.unknown()) }) })
          .parse(JSON.parse(output)).result.tools;
      },
      foreignControl: async (c, foreign) => {
        const names = new Set(clients.map((x) => x.name));
        if (c.name === foreign.name || !names.has(c.name) || !names.has(foreign.name)) {
          throw new Error("foreignControl needs two distinct clients of this batch.");
        }
        const stored = z
          .object({ session: z.object({ outcome: z.literal("ready"), sessionUuid: z.string() }) })
          .parse(JSON.parse(proxy.readFile(join(batchDir, "sessions", foreign.name, "init.json"))));
        // tapOn is gated by the broker connection; the target matches nothing even if it ran.
        const reply = await command([
          "call",
          "tapOn",
          JSON.stringify({
            sessionUuid: stored.session.sessionUuid,
            text: "__automobile_cross_client_probe_no_match__",
          }),
          "--client",
          c.name,
          "--allow-foreign-session",
          foreign.name,
        ]);
        const response = z
          .object({ result: z.record(z.unknown()).optional() })
          .passthrough()
          .safeParse(JSON.parse(reply.output));
        const code = response.success
          ? readToolEnvelopePayload(response.data.result)?.payload?.code
          : undefined;
        return { code: reply.code === 1 && typeof code === "string" ? code : null };
      },
      ownerKill: async (c) => {
        await checked(["owner-kill", "--client", c.name]);
      },
      proxyClosed: async (c) => proxy.exists(join(batchDir, "sessions", c.name, "closed.json")),
      close: closeClient,
      devicesView,
      resources: async () => ({
        unavailable:
          "No read-only broker resource-state RPC is exposed; native inventory does not prove resource destruction.",
      }),
    },
  };
  return {
    context,
    close: async () => {
      // runBrokerScenario joins every client's cleanup. Refuse to discard a failed close, but
      // never let one client's failure strand a sibling's proxy: close all, then report.
      const failures: unknown[] = [];
      for (const name of [...started].reverse()) {
        try {
          await closeClient(clients.find((c) => c.name === name)!);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `${failures.length} broker clients failed to close`);
      }
    },
  };
}
