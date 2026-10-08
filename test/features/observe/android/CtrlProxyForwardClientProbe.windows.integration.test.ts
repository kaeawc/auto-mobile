import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { HostForwardClientConnectionProbe } from "../../../../src/features/observe/android/CtrlProxyForwardClientProbe";
import type { ExecResult } from "../../../../src/models";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
  type HostCommandOptions,
} from "../../../../src/utils/HostCommandExecutor";

// Real Windows `netstat -ano` truth for #10717. Spawning netstat costs far more
// than the 100 ms unit budget, so this runs in the host-integration lane, which
// CI executes on windows-latest. The raw output is written under
// scratch/netstat-capture (uploaded by the workflow) so a captured fixture can
// replace the hand-written one in CtrlProxyForwardClientProbe.test.ts.
const windowsTest = process.platform === "win32" ? test : test.skip;
const CAPTURE_DIR =
  process.env.AUTOMOBILE_NETSTAT_CAPTURE_DIR ?? path.join("scratch", "netstat-capture");

/** Runs the real netstat and keeps its raw stdout per protocol. */
class RecordingHost implements HostCommandExecutor {
  readonly outputs = new Map<string, string>();
  private readonly real = new DefaultHostCommandExecutor();
  async executeCommand(
    file: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    const result = await this.real.executeCommand(file, args, options);
    this.outputs.set([file, ...args].join(" "), result.stdout);
    return result;
  }
}

interface Loopback {
  server: net.Server;
  client: net.Socket;
  serverPort: number;
  clientPort: number;
}

function listen(server: net.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

async function openLoopback(host: string): Promise<Loopback> {
  const server = net.createServer();
  const accepted = new Promise<net.Socket>((resolve) => {
    server.once("connection", resolve);
  });
  const serverPort = await listen(server, host);
  const client = net.connect({ host, port: serverPort });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const peer = await accepted;
  opened.push(server, client, peer);
  return { server, client, serverPort, clientPort: client.localPort ?? 0 };
}

const opened: Array<net.Server | net.Socket> = [];

afterEach(() => {
  for (const handle of opened.splice(0)) {
    handle.destroy?.();
    if (handle instanceof net.Server) {
      handle.close();
    }
  }
});

function capture(host: RecordingHost, label: string): void {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const [command, stdout] of host.outputs) {
    const name = `${label}-${command.replace(/[^A-Za-z0-9]+/g, "_")}.txt`;
    writeFileSync(path.join(CAPTURE_DIR, name), stdout);
  }
}

describe("HostForwardClientConnectionProbe against real Windows netstat", () => {
  windowsTest(
    "finds this process as the IPv4 loopback client and ignores the listener",
    async () => {
      const { serverPort } = await openLoopback("127.0.0.1");
      const host = new RecordingHost();
      const probe = new HostForwardClientConnectionProbe(host, "win32");

      const pids = await probe.findClientPids(serverPort);
      capture(host, "ipv4");

      expect(pids).toContain(process.pid);
      // LISTENING rows have foreign 0.0.0.0:0; they must never count as clients.
      expect(await probe.findClientPids(0)).toEqual([]);
    },
  );

  windowsTest("finds this process as the IPv6 loopback client when ::1 is available", async () => {
    let loopback: Loopback;
    try {
      loopback = await openLoopback("::1");
    } catch (error) {
      // IPv6 loopback is optional on a runner; the IPv4 test already covers the parser.
      console.warn(`IPv6 loopback unavailable, skipping: ${String(error)}`);
      return;
    }
    const host = new RecordingHost();
    const probe = new HostForwardClientConnectionProbe(host, "win32");

    const pids = await probe.findClientPids(loopback.serverPort);
    capture(host, "ipv6");

    expect(pids).toContain(process.pid);
    expect(await probe.findClientPids(0)).toEqual([]);
  });
});
