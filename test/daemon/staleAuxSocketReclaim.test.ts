import { describe, expect, test } from "bun:test";
import type {
  DaemonSocketReachabilityLike,
  SocketReachability,
} from "../../src/daemon/client/daemonSocketReachability";
import type { SocketFileIdentity, SocketPathFs } from "../../src/daemon/socketFileIdentity";
import { decideStaleAuxSocketReclaim } from "../../src/daemon/staleAuxSocketReclaim";

class FakeSocketPathFs implements SocketPathFs {
  present = true;
  denied = false;
  identity: SocketFileIdentity = { dev: 1n, ino: 2n };

  exists(_path: string): boolean {
    return this.present;
  }

  stat(_path: string): SocketFileIdentity {
    if (this.denied) {
      throw Object.assign(new Error("stat denied"), { code: "EACCES" });
    }
    return this.identity;
  }
}

class FakeReachability implements DaemonSocketReachabilityLike {
  readonly calls: Array<{ socketPath: string; timeoutMs: number }> = [];
  onProbe: (attempt: number) => SocketReachability = () => "absent";

  async probe(socketPath: string, timeoutMs: number): Promise<SocketReachability> {
    this.calls.push({ socketPath, timeoutMs });
    return this.onProbe(this.calls.length);
  }
}

function fixture(platform: NodeJS.Platform = "linux") {
  const fs = new FakeSocketPathFs();
  const reachability = new FakeReachability();
  const probe = { socketPath: "aux.sock", timeoutMs: 17 };
  return {
    fs,
    reachability,
    probe,
    decide: () =>
      decideStaleAuxSocketReclaim({
        socketPath: probe.socketPath,
        platform,
        reachability,
        probeTimeoutMs: probe.timeoutMs,
        fs,
      }),
  };
}

describe("decideStaleAuxSocketReclaim", () => {
  test("an inconclusive first probe preserves the path", async () => {
    const f = fixture();
    f.reachability.onProbe = () => "unknown";
    expect(await f.decide()).toBe("unknown");
    expect(f.reachability.calls).toEqual([f.probe]);
  });

  test("win32 preserves a stat-denied path after an inconclusive second probe", async () => {
    const f = fixture("win32");
    f.fs.denied = true;
    f.reachability.onProbe = (attempt) => (attempt === 2 ? "unknown" : "absent");
    expect(await f.decide()).toBe("unknown");
    expect(f.reachability.calls).toEqual([f.probe, f.probe]);
  });

  test("absent paths need no probe", async () => {
    const f = fixture();
    f.fs.present = false;
    expect(await f.decide()).toBe("absent");
    expect(f.reachability.calls).toEqual([]);
  });

  test("a reachable first probe holds the path", async () => {
    const f = fixture();
    f.reachability.onProbe = () => "answered";
    expect(await f.decide()).toBe("held");
    expect(f.reachability.calls).toEqual([f.probe]);
  });

  test("a path removed during the first probe is absent", async () => {
    const f = fixture();
    f.reachability.onProbe = () => {
      f.fs.present = false;
      return "absent";
    };
    expect(await f.decide()).toBe("absent");
    expect(f.reachability.calls).toEqual([f.probe]);
  });

  for (const platform of ["linux", "darwin"] satisfies NodeJS.Platform[]) {
    test(`${platform} reclaims an owned identity with one probe`, async () => {
      const f = fixture(platform);
      expect(await f.decide()).toBe("unlink");
      expect(f.reachability.calls).toEqual([f.probe]);
    });

    test(`${platform} refuses a stat-denied path with one probe`, async () => {
      const f = fixture(platform);
      f.fs.denied = true;
      expect(await f.decide()).toBe("conflict");
      expect(f.reachability.calls).toEqual([f.probe]);
    });
  }

  test("a replaced identity conflicts", async () => {
    const f = fixture();
    f.reachability.onProbe = () => {
      f.fs.identity = { dev: 1n, ino: 3n };
      return "absent";
    };
    expect(await f.decide()).toBe("conflict");
    expect(f.reachability.calls).toEqual([f.probe]);
  });

  test("win32 conflicts when a readable identity no longer matches", async () => {
    const f = fixture("win32");
    f.reachability.onProbe = () => {
      f.fs.identity = { dev: 1n, ino: 3n };
      return "absent";
    };
    expect(await f.decide()).toBe("conflict");
    expect(f.reachability.calls).toEqual([f.probe]);
  });

  test("win32 reclaims a stat-denied path after two bounded probes", async () => {
    const f = fixture("win32");
    f.fs.denied = true;
    expect(await f.decide()).toBe("unlink");
    expect(f.reachability.calls).toEqual([f.probe, f.probe]);
  });

  test("win32 preserves a successor answering the second probe", async () => {
    const f = fixture("win32");
    f.fs.denied = true;
    f.reachability.onProbe = (attempt) => (attempt === 2 ? "answered" : "absent");
    expect(await f.decide()).toBe("held");
    expect(f.reachability.calls).toEqual([f.probe, f.probe]);
  });

  test("win32 reports absent after disappearance during the second probe", async () => {
    const f = fixture("win32");
    f.fs.denied = true;
    f.reachability.onProbe = (attempt) => {
      if (attempt === 2) {
        f.fs.present = false;
      }
      return "absent";
    };
    expect(await f.decide()).toBe("absent");
    expect(f.reachability.calls).toEqual([f.probe, f.probe]);
  });

  test("win32 needs only one probe with a matching readable identity", async () => {
    const f = fixture("win32");
    expect(await f.decide()).toBe("unlink");
    expect(f.reachability.calls).toEqual([f.probe]);
  });
});
