import { describe, expect, test, spyOn } from "bun:test";
import {
  checkSpotlightIndexing,
  type SpotlightProbe,
} from "../../../src/doctor/checks/spotlightIndexing";
import { logger } from "../../../src/utils/logger";

class FakeSpotlightProbe implements SpotlightProbe {
  directories = new Set<string>(["/repo/scratch"]);
  markers = new Set<string>();
  status = "Indexing enabled.";
  calls: { dir: string; timeoutMs: number }[] = [];
  exists(dir: string): boolean {
    return this.directories.has(dir);
  }
  hasMarker(dir: string): boolean {
    return this.markers.has(dir);
  }
  async indexingStatus(dir: string, timeoutMs: number): Promise<string> {
    this.calls.push({ dir, timeoutMs });
    return this.status;
  }
}

function run(probe: SpotlightProbe, platform: NodeJS.Platform = "darwin") {
  return checkSpotlightIndexing(
    { probe, platform, repoRoot: "/repo", homeDir: "/home/dev" },
    { timeoutMs: 17 },
  );
}

describe("Spotlight Indexing", () => {
  test("skips non-Darwin without probing", async () => {
    const probe = new FakeSpotlightProbe();
    expect((await run(probe, "linux")).status).toBe("skip");
    expect(probe.calls).toEqual([]);
  });
  test("all present markers pass without mdutil", async () => {
    const probe = new FakeSpotlightProbe();
    probe.markers.add("/repo/scratch");
    expect((await run(probe)).status).toBe("pass");
    expect(probe.calls).toEqual([]);
  });
  test("mdutil disabled counts as excluded and receives timeout", async () => {
    const probe = new FakeSpotlightProbe();
    probe.status = "/repo/scratch:\n Indexing disabled.";
    expect((await run(probe)).status).toBe("pass");
    expect(probe.calls).toEqual([{ dir: "/repo/scratch", timeoutMs: 17 }]);
  });
  test("indexed directory warns with manual remedies", async () => {
    const result = await run(new FakeSpotlightProbe());
    expect(result.status).toBe("warn");
    expect(result.message).toContain("/repo/scratch");
    expect(result.message).toContain("only marker files and volume-wide mdutil status");
    expect(result.recommendation).toContain("already excluded via Search Privacy");
    expect(result.recommendation).toContain("ignore it or add the marker");
    expect(result.recommendation).toContain("touch");
    expect(result.recommendation).toContain("Search Privacy");
    expect(result.recommendation).toContain("OPTIONAL");
  });
  test("ignores nonexistent candidates", async () => {
    const probe = new FakeSpotlightProbe();
    await run(probe);
    expect(probe.calls.map(({ dir }) => dir)).toEqual(["/repo/scratch"]);
  });
  test("no existing candidates passes", async () => {
    const probe = new FakeSpotlightProbe();
    probe.directories.clear();
    expect((await run(probe)).status).toBe("pass");
  });
  test("probe failures warn without throwing", async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const probe: SpotlightProbe = {
        exists: () => {
          throw new Error("denied");
        },
        hasMarker: () => false,
        indexingStatus: async () => "",
      };
      expect((await run(probe)).status).toBe("warn");
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
  test("probe contract exposes only read operations", async () => {
    const calls: string[] = [];
    const probe: SpotlightProbe = {
      exists: (dir) => {
        calls.push(`exists:${dir}`);
        return true;
      },
      hasMarker: (dir) => {
        calls.push(`marker:${dir}`);
        return false;
      },
      indexingStatus: async (dir) => {
        calls.push(`status:${dir}`);
        return "Indexing disabled";
      },
    };
    expect((await run(probe)).status).toBe("pass");
    expect(calls.filter((call) => call.startsWith("status:"))).toEqual([
      "status:/repo/scratch",
      "status:/repo/.claude/worktrees",
      "status:/home/dev/.auto-mobile",
      "status:/tmp/automobile-ctrl-proxy",
      "status:/home/dev/Library/Developer/Xcode/DerivedData",
      "status:/home/dev/.gradle",
    ]);
  });
});
