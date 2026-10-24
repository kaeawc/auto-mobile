import { generateDaemonHttpToken } from "../src/daemon/daemonHttpToken";
import { defaultIdGenerator } from "../src/utils/IdGenerator";
/**
 * Per-request latency of the daemon's stateless MCP HTTP endpoint (#13068).
 *
 * Starts the REAL daemon HTTP listener (`/auto-mobile/streamable`, the path the socket server's
 * loopback client and the desktop app use) on a loopback port, then times sequential POSTs over
 * real HTTP: `ping` and a trivial `tools/call` (`setToolEnabled`). Every POST builds its own
 * server and transport, exactly as in production.
 *
 * No device, emulator, simulator or resident daemon is touched: device discovery is a fake whose
 * cost is modelled by `--discovery-cost-ms` (a synchronous busy wait standing in for spawning adb
 * and simctl and parsing their output on the event loop), and data/log/DB dirs are fresh temp
 * dirs. The report counts discovery probes per request, which must stay at zero once warm.
 *
 * Usage:
 *   bun scripts/benchmark-stateless-endpoint.ts [--iterations 200] [--warmup 30]
 *     [--discovery-cost-ms 5] [--max-p50-ms 6] [--json]
 */
import { mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface Options {
  iterations: number;
  warmup: number;
  discoveryCostMs: number;
  maxP50Ms: number | undefined;
  json: boolean;
}

interface CallStats {
  label: string;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  probesPerRequest: number;
}

function nonNegative(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number, got ${raw}`);
  }
  return value;
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      iterations: { type: "string", default: "200" },
      warmup: { type: "string", default: "30" },
      "discovery-cost-ms": { type: "string", default: "5" },
      "max-p50-ms": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const maxP50 = values["max-p50-ms"];
  return {
    iterations: Math.max(1, Math.floor(nonNegative("iterations", values.iterations))),
    warmup: Math.floor(nonNegative("warmup", values.warmup)),
    discoveryCostMs: nonNegative("discovery-cost-ms", values["discovery-cost-ms"]),
    maxP50Ms: maxP50 === undefined ? undefined : nonNegative("max-p50-ms", maxP50),
    json: values.json ?? false,
  };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Models synchronous spawn + output parsing on the event loop. */
function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

/** Keep every write of this run out of the real ~/.auto-mobile (must precede the src imports). */
function isolateDataDirs(): void {
  for (const name of ["AUTOMOBILE_DATA_DIR", "AUTOMOBILE_LOG_DIR", "AUTOMOBILE_DB_DIR"]) {
    process.env[name] = mkdtempSync(join(tmpdir(), `am-bench-stateless-${name.toLowerCase()}-`));
  }
}

function report(options: Options, results: CallStats[]): void {
  if (options.json) {
    console.log(JSON.stringify({ options, results }, null, 2));
    return;
  }
  console.log(
    `stateless endpoint, N=${options.iterations} (warm-up ${options.warmup}), ` +
      `modelled discovery cost ${options.discoveryCostMs} ms`,
  );
  for (const r of results) {
    console.log(
      `${r.label.padEnd(28)} p50 ${r.p50.toFixed(2)} ms  p90 ${r.p90.toFixed(2)} ms  ` +
        `p99 ${r.p99.toFixed(2)} ms  max ${r.max.toFixed(2)} ms  ` +
        `probes/request ${r.probesPerRequest}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  isolateDataDirs();

  const [{ Daemon }, { MCP_STREAMABLE_PATH }, { PlatformDeviceManagerFactory }, { defaultTimer }] =
    await Promise.all([
      import("../src/daemon/daemon"),
      import("../src/daemon/wire/constants"),
      import("../src/utils/factories/PlatformDeviceManagerFactory"),
      import("../src/utils/SystemTimer"),
    ]);

  let probes = 0;
  const discover = async () => {
    probes++;
    busyWait(options.discoveryCostMs);
    return [];
  };
  PlatformDeviceManagerFactory.setInstance({
    getBootedDevices: discover,
    getBootedDevicesDetailed: async () => ({
      devices: await discover(),
      succeededPlatforms: new Set(["android", "ios"]),
    }),
  } as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);

  const port = await freePort();
  const httpToken = generateDaemonHttpToken(defaultIdGenerator);
  const daemon = new Daemon({ port, host: "127.0.0.1" }, { timer: defaultTimer, httpToken });
  // The HTTP listener lifecycle is private; Daemon.start() would also boot devices and the DB.
  const call = async (method: string): Promise<void> => {
    await Reflect.get(daemon, method).call(daemon);
  };
  await Reflect.get(daemon, "httpIngress").start();
  await call("resolveStartupCompletion");

  const url = `http://127.0.0.1:${port}${MCP_STREAMABLE_PATH}`;
  let nextId = 0;
  const post = async (body: Record<string, unknown>): Promise<void> => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${httpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-auto-mobile-mcp-session-id": "benchmark-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, ...body }),
    });
    const text = await response.text();
    if (response.status !== 200 || !text.includes('"result"')) {
      throw new Error(`Unexpected response ${response.status}: ${text.slice(0, 300)}`);
    }
  };

  const measure = async (label: string, body: Record<string, unknown>): Promise<CallStats> => {
    for (let i = 0; i < options.warmup; i++) {
      await post(body);
    }
    const probesBefore = probes;
    const samples: number[] = [];
    for (let i = 0; i < options.iterations; i++) {
      const started = performance.now();
      await post(body);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    return {
      label,
      p50: percentile(samples, 0.5),
      p90: percentile(samples, 0.9),
      p99: percentile(samples, 0.99),
      max: samples[samples.length - 1],
      probesPerRequest: (probes - probesBefore) / options.iterations,
    };
  };

  let results: CallStats[];
  try {
    results = [
      await measure("ping", { method: "ping" }),
      await measure("tools/call setToolEnabled", {
        method: "tools/call",
        params: { name: "setToolEnabled", arguments: { toolName: "observe", enabled: true } },
      }),
    ];
  } finally {
    await Reflect.get(daemon, "httpIngress").closeListener();
  }

  report(options, results);
  const budget = options.maxP50Ms;
  const overBudget = budget === undefined ? [] : results.filter((r) => r.p50 > budget);
  for (const r of overBudget) {
    console.error(`${r.label}: p50 ${r.p50.toFixed(2)} ms exceeds --max-p50-ms ${budget}`);
  }
  process.exit(overBudget.length > 0 ? 1 : 0);
}

await main();
