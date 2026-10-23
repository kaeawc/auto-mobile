import { describe, expect, test } from "bun:test";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { existsSync, lstatSync } from "node:fs";
import {
  isOwnedSocketFile,
  readSocketFileIdentity,
  statFileIdentity,
} from "../../src/daemon/socketFileIdentity";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultTimer } from "../../src/utils/SystemTimer";

const sleep = (ms: number) => new Promise<void>((r) => defaultTimer.setTimeout(r, ms));

function probe(path: string): Promise<string> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    s.once("connect", () => {
      s.destroy();
      resolve("connected");
    });
    s.once("error", (e: NodeJS.ErrnoException) => resolve(`error:${e.code ?? e.message}`));
  });
}

async function scenario(path: string, withOpenClient: boolean) {
  const accepted: Socket[] = [];
  const server: Server = createServer((s) => {
    accepted.push(s);
    s.on("error", () => {});
  });
  const out: Record<string, unknown> = { path, withOpenClient };
  let recorded: ReturnType<typeof readSocketFileIdentity> = null;
  await new Promise<void>((r) =>
    server.listen(path, () => {
      recorded = readSocketFileIdentity(path);
      out.identityInListenCallback = recorded ? `${recorded.dev}:${recorded.ino}` : null;
      r();
    }),
  );
  out.ownedAfterListen = isOwnedSocketFile(recorded, path);
  out.existsWhileListening = existsSync(path);
  const ident = () => {
    try {
      const i = statFileIdentity(path);
      return `${i.dev}:${i.ino}`;
    } catch (e) {
      return `throw:${(e as NodeJS.ErrnoException).code ?? e}`;
    }
  };
  out.identity1 = ident();
  out.identity2 = ident();
  try {
    const l = lstatSync(path);
    out.lstat = {
      isSocket: l.isSocket(),
      isFile: l.isFile(),
      isSymlink: l.isSymbolicLink(),
      mode: l.mode,
    };
  } catch (e) {
    out.lstat = `throw:${(e as NodeJS.ErrnoException).code ?? e}`;
  }
  let client: Socket | undefined;
  if (withOpenClient) {
    client = createConnection(path);
    client.on("error", () => {});
    await new Promise<void>((r) => client!.once("connect", () => r()));
  }
  out.probeWhileListening = await probe(path);
  const closeCb = new Promise<void>((r) => server.close(() => r()));
  out.listeningAfterCloseCall = server.listening;
  out.probeImmediatelyAfterCloseCall = await probe(path);
  if (!withOpenClient) {
    await closeCb;
    out.closeCallbackFired = true;
  } else {
    client!.destroy();
    for (const s of accepted) {
      s.destroy();
    }
    await closeCb;
    out.closeCallbackFired = true;
  }
  out.existsAfterClose = existsSync(path);
  const timeline: Record<string, string> = {};
  let elapsed = 0;
  for (const delay of [0, 5, 15, 30, 50, 100, 300, 500]) {
    await sleep(delay);
    elapsed += delay;
    timeline[`${elapsed}ms`] = await probe(path);
  }
  out.timeline = timeline;
  return out;
}

describe("net.Server close reachability diagnostics", () => {
  test("file path, no open client", async () => {
    const r = await scenario(join(tmpdir(), `diag-a-${randomUUID()}.sock`), false);
    console.log(`DIAG ${JSON.stringify(r)}`);
    expect(true).toBe(true);
  });
  test("file path, open client during close", async () => {
    const r = await scenario(join(tmpdir(), `diag-b-${randomUUID()}.sock`), true);
    console.log(`DIAG ${JSON.stringify(r)}`);
    expect(true).toBe(true);
  });
  test.skipIf(process.platform !== "win32")("named pipe path", async () => {
    const r = await scenario(`\\\\.\\pipe\\diag-c-${randomUUID()}`, false);
    console.log(`DIAG ${JSON.stringify(r)}`);
    expect(true).toBe(true);
  });
});
