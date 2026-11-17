import { expect, spyOn, test } from "bun:test";
import {
  invokeTool,
  main,
  PLAYGROUND_BUNDLE_ID,
  probeCtrlProxyQueue,
  collectScenarioFindings,
  readStorageCapabilities,
  parseOptions,
  selectScenarios,
} from "../../../scripts/ios/sdk-contract/run";

test("failed CLI calls prefer structured tool diagnostics over the command line", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const detail = 'Target "Contract web increment" is covered by a UITableViewCell';
  const longDetail = `${detail} ${"detail ".repeat(100)}`;
  try {
    for (const result of [
      { success: false, error: longDetail, message: "generic failure" },
      { success: false, message: longDetail },
      { success: false, commands: [{ success: false, error: longDetail }], message: "generic" },
      { success: false, commands: [{ success: false, message: longDetail }] },
      { success: false, error: 42, message: longDetail },
      {
        success: false,
        commands: [
          null,
          { success: true, error: "not a failure" },
          { success: false, error: longDetail },
        ],
      },
    ]) {
      for (const stdout of [
        JSON.stringify(result),
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }),
      ]) {
        const outcome = await invokeTool("tapOn", {}, "session", async () => {
          throw Object.assign(new Error("Command failed: bun tool --selector long-argv"), {
            stdout,
            stderr: "less useful stderr",
          });
        });
        expect(outcome.result).toEqual(result);
        expect(outcome.error).toBe(longDetail.slice(0, 240));
        expect(outcome.error).not.toContain("Command failed:");
      }
    }
    expect(warning).toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

test("failed CLI calls fall back to a bounded stderr tail, then the exception", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const stderr = `${"debug ".repeat(100)}\nbridge unavailable`;
  try {
    for (const stdout of ["", "not JSON", "null", "{}", '{"error":42,"message":""}']) {
      const outcome = await invokeTool("sendKeys", {}, "session", async () => {
        throw Object.assign(new Error("Command failed: bun long-argv"), { stdout, stderr });
      });
      expect(outcome.error).toBe(stderr.slice(-240));
    }
    for (const error of [new Error("failure ".repeat(100)), "plain failure", null]) {
      const outcome = await invokeTool("tapOn", {}, "session", async () => {
        throw error;
      });
      expect(outcome.error).toBe(
        (error instanceof Error ? error.message : String(error)).slice(0, 240),
      );
    }
  } finally {
    warning.mockRestore();
  }
});

test("successful CLI transport retains success and normalizes tool-declared failures", async () => {
  const success = { success: true, backend: "sdk" };
  expect(await invokeTool("tapOn", {}, "session", async () => success)).toEqual({
    result: success,
  });
  const result = { success: false, message: "tool rejected the target" };
  expect(await invokeTool("tapOn", {}, "session", async () => result)).toEqual({
    result,
    error: result.message,
  });
  expect(await invokeTool("tapOn", {}, "session", async () => ({ success: false }))).toEqual({
    result: { success: false },
    error: "tool reported success: false",
  });
});

test("--only selects named scenarios once in suite order, with all scenarios by default", () => {
  const args = ["--device", "fake", "--app", "fake.app"];
  expect(selectScenarios(parseOptions(args).only)).toEqual([
    "network",
    "navigation",
    "capabilities",
    "faults",
    "observe",
    "web-view",
    "storage-default",
    "storage",
  ]);
  expect(parseOptions([...args, "--only", "web-view"]).only).toEqual(["web-view"]);
  expect(
    selectScenarios(parseOptions([...args, "--only", "storage,web-view,web-view"]).only),
  ).toEqual(["web-view", "storage"]);
});

test("--only rejects unknown, empty and missing names as usage errors", () => {
  const args = ["--device", "fake", "--app", "fake.app", "--only"];
  for (const values of [
    [],
    ["typo"],
    [""],
    ["web-view,"],
    ["web-view,typo"],
    ["--report", "out.json"],
  ]) {
    expect(() => parseOptions([...args, ...values])).toThrow("Usage: --only");
  }
  expect(() => parseOptions([])).toThrow("[--only <scenario[,scenario]>]");
});

test("main passes --only to the scenario runner", async () => {
  const selected: string[][] = [];
  expect(
    await main(["--device", "fake", "--app", "fake.app", "--only", "web-view"], {
      acquire: async () => ({ sessionUuid: "session", ctrlProxyPort: 1 }),
      run: async (options) => {
        selected.push(selectScenarios(options.only));
        return [];
      },
      cleanup: async () => {},
      writeReport: async () => {},
      output: () => {},
    }),
  ).toBe(0);
  expect(selected).toEqual([["web-view"]]);
});

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
