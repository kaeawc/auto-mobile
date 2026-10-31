import { expect, test } from "bun:test";
import {
  main,
  PLAYGROUND_BUNDLE_ID,
  probeCtrlProxyQueue,
  collectScenarioFindings,
  readStorageCapabilities,
} from "../../../scripts/ios/sdk-contract/run";

test("a failed queue probe preserves unknown rather than claiming an empty queue", async () => {
  const failFetch = async () => {
    throw new Error("offline");
  };
  expect(await probeCtrlProxyQueue(1, failFetch)).toBeUndefined();
});

test("a throwing scenario still outputs findings, writes a report and exits 1", async () => {
  const reports: string[] = [];
  const output: string[] = [];
  let cleaned = false;
  const code = await main(["--device", "fake", "--app", "fake.app", "--report", "fake.json"], {
    acquire: async () => ({ sessionUuid: "session", ctrlProxyPort: 1 }),
    run: async () => {
      throw new Error("resource read failed");
    },
    cleanup: async () => {
      cleaned = true;
    },
    writeReport: async (_path, contents) => {
      reports.push(contents);
    },
    output: (text) => {
      output.push(text);
    },
  });
  expect(code).toBe(1);
  expect(cleaned).toBe(true);
  expect(output[0]).toContain("resource read failed");
  expect(JSON.parse(reports[0]).findings).toHaveLength(1);
});

test("the harness exports the existing Playground identity", () => {
  expect(PLAYGROUND_BUNDLE_ID).toBe("dev.jasonpearson.automobile.Playground");
});

for (const phase of ["connect", "read"] as const) {
  test(`a ${phase} exception is reported at the MCP boundary and later scenarios still run`, async () => {
    const reports: string[] = [];
    const visited: string[] = [];
    let closed = false;
    const code = await main(["--device", "fake", "--app", "fake.app", "--report", "fake.json"], {
      acquire: async () => ({ sessionUuid: "session", ctrlProxyPort: 1 }),
      run: async () =>
        collectScenarioFindings(["storage", "next"], async (scenario) => {
          visited.push(scenario);
          if (scenario === "storage") {
            await readStorageCapabilities("fake", async () => {
              if (phase === "connect") {
                throw new Error("connect failed");
              }
              return {
                readResource: async () => {
                  throw new Error("read failed");
                },
                close: async () => {
                  closed = true;
                },
              };
            });
          }
          return [];
        }),
      cleanup: async () => {},
      writeReport: async (_path, contents) => {
        reports.push(contents);
      },
      output: () => {},
    });
    expect(code).toBe(1);
    expect(visited).toEqual(["storage", "next"]);
    expect(closed).toBe(phase === "read");
    expect(JSON.parse(reports[0]).findings).toEqual([
      expect.objectContaining({
        slice: "storage",
        caseName: "run",
        boundary: "mcp-surface",
        message: expect.stringContaining(`${phase} failed`),
      }),
    ]);
  });
}

test("a successful harness run still reports PASS and exits zero", async () => {
  const output: string[] = [];
  const code = await main(["--device", "fake", "--app", "fake.app"], {
    acquire: async () => ({ sessionUuid: "session", ctrlProxyPort: 1 }),
    run: async () => [],
    cleanup: async () => {},
    writeReport: async () => {},
    output: (text) => {
      output.push(text);
    },
  });
  expect(code).toBe(0);
  expect(output[0]).toStartWith("PASS");
});

test("an unsuccessful HTTP queue probe also preserves unknown", async () => {
  expect(
    await probeCtrlProxyQueue(1, async () => ({ ok: false, status: 503, text: async () => "[]" })),
  ).toBeUndefined();
});

test("a successful empty queue probe is conclusive", async () => {
  expect(
    await probeCtrlProxyQueue(1, async () => ({ ok: true, status: 200, text: async () => "[]" })),
  ).toEqual(new Set());
});
