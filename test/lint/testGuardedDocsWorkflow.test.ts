import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

interface Workflow {
  jobs: Record<
    string,
    {
      if?: string;
      steps: { id?: string; with?: { script?: string } }[];
    }
  >;
}

const workflow = load(
  readFileSync(join(import.meta.dir, "../../.github/workflows/pull_request.yml"), "utf8"),
) as Workflow;
const guardedDoc = "docs/using/screen-control.md";

interface ListFilesParameters {
  per_page?: number;
  page?: number;
}

interface ChangedFile {
  filename: string;
}

type ListFilesEndpoint = (params: ListFilesParameters) => Promise<{ data: ChangedFile[] }>;

interface ClassifyOptions {
  payloadChangedFiles?: unknown;
  apiChangedFiles?: unknown;
  failPrDetails?: boolean;
}

async function classify(
  stepId: string,
  filenames: string[],
  scriptOverride?: string,
  options: ClassifyOptions = {},
): Promise<Record<string, string>> {
  const script =
    scriptOverride ??
    workflow.jobs["detect-changes"].steps.find((step) => step.id === stepId)?.with?.script;
  if (!script) {
    throw new Error(`Missing classifier script ${stepId}`);
  }
  const files = filenames.map((filename) => ({ filename }));
  const pr = {
    title: "chore: update docs",
    head: { ref: "auto-update/docs", repo: { full_name: "kaeawc/auto-mobile" } },
    changed_files: Object.hasOwn(options, "apiChangedFiles")
      ? options.apiChangedFiles
      : filenames.length,
  };
  // Execute the YAML-owned scripts with fake GitHub data: no network or Actions runner.
  const github = {
    rest: {
      pulls: {
        listFiles: async (params: ListFilesParameters) => {
          const pageSize = Math.min(params.per_page ?? 30, 100);
          const start = ((params.page ?? 1) - 1) * pageSize;
          // The real endpoint exposes at most 3000 files, even with pagination.
          return { data: files.slice(0, 3000).slice(start, start + pageSize) };
        },
        get: async () => {
          if (options.failPrDetails) {
            throw new Error("PR details unavailable");
          }
          return { data: pr };
        },
      },
    },
    paginate: async (endpoint: ListFilesEndpoint, params: ListFilesParameters) => {
      const result: ChangedFile[] = [];
      const pageSize = Math.min(params.per_page ?? 30, 100);
      for (let page = 1; ; page++) {
        const { data } = await endpoint({ ...params, page });
        result.push(...data);
        if (data.length < pageSize) {
          return result;
        }
      }
    },
  };
  const context = {
    issue: { number: 1 },
    repo: { owner: "kaeawc", repo: "auto-mobile" },
    payload: {
      pull_request: {
        labels: [{ name: "automated" }, { name: "documentation" }],
        changed_files: Object.hasOwn(options, "payloadChangedFiles")
          ? options.payloadChangedFiles
          : filenames.length,
      },
    },
  };
  const outputs: Record<string, string> = {};
  const core = {
    setOutput: (key: string, value: string) => {
      outputs[key] = value;
    },
  };
  const run = new Function(
    "github",
    "context",
    "core",
    "console",
    `return (async () => {\n${script}\n})();`,
  );
  await run(github, context, core, { log: () => {} });
  return outputs;
}

function docs(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `docs/page-${index.toString().padStart(4, "0")}.md`,
  );
}

describe("contract-bearing docs keep their Node test guard in CI", () => {
  for (const [step, output] of [
    ["filter", "docs_only"],
    ["check-auto-chore", "auto_chore"],
  ]) {
    test(`${step} runs code gates for the guarded page alone or with ordinary docs`, async () => {
      expect((await classify(step, [guardedDoc]))[output]).toBe("false");
      expect((await classify(step, ["docs/using/overview.md", guardedDoc]))[output]).toBe("false");
    });
    test(`${step} preserves ordinary docs-only and empty-change classification`, async () => {
      expect((await classify(step, ["docs/using/overview.md", "README.md"]))[output]).toBe("true");
      expect((await classify(step, []))[output]).toBe("false");
      expect((await classify(step, ["src/daemon/socketServer.ts"]))[output]).toBe("false");
    });
    test(`${step} negative control would skip the page without its exemption`, async () => {
      const script = workflow.jobs["detect-changes"].steps.find((item) => item.id === step)?.with
        ?.script;
      if (!script) {
        throw new Error(`Missing classifier script ${step}`);
      }
      // Remove just the known path, then prove the broken script skips the guard.
      expect(script).toContain(JSON.stringify(guardedDoc));
      const broken = script.replace(JSON.stringify(guardedDoc), '"docs/unused.md"');
      expect((await classify(step, [guardedDoc], broken))[output]).toBe("true");
    });

    for (const count of [30, 100, 101, 150]) {
      test(`${step} accepts all ${count} docs files across pagination boundaries`, async () => {
        expect((await classify(step, docs(count)))[output]).toBe("true");
      });
    }

    for (const count of [30, 31, 35, 100]) {
      test(`${step} finds code after ${count} docs files`, async () => {
        const filenames = [...docs(count), "src/daemon/socketServer.ts"].sort();
        expect((await classify(step, filenames))[output]).toBe("false");
      });
    }

    test(`${step} finds the guarded doc beyond the first page`, async () => {
      expect((await classify(step, [...docs(101), guardedDoc].sort()))[output]).toBe("false");
    });

    for (const [enumerated, expected] of [
      [150, 200],
      [3000, 3001],
    ]) {
      test(`${step} fails closed for ${enumerated} enumerated of ${expected} reported files`, async () => {
        const result = await classify(step, docs(enumerated), undefined, {
          payloadChangedFiles: expected,
        });
        expect(result[output]).toBe("false");
      });
    }

    test(`${step} fails closed when the endpoint caps an actual 3001-file PR`, async () => {
      expect((await classify(step, docs(3001)))[output]).toBe("false");
    });

    test(`${step} uses the payload count before the API count`, async () => {
      expect((await classify(step, docs(150), undefined, { apiChangedFiles: 200 }))[output]).toBe(
        "true",
      );
    });

    for (const payloadChangedFiles of [undefined, null, "150", Number.NaN]) {
      test(`${step} falls back to PR details for payload count ${String(payloadChangedFiles)}`, async () => {
        expect((await classify(step, docs(150), undefined, { payloadChangedFiles }))[output]).toBe(
          "true",
        );
        expect(
          (
            await classify(step, docs(150), undefined, {
              payloadChangedFiles,
              apiChangedFiles: 200,
            })
          )[output],
        ).toBe("false");
      });
    }

    for (const apiChangedFiles of [undefined, null, "150", Number.NaN, Infinity, -1, 1.5]) {
      test(`${step} fails closed for undetermined API count ${String(apiChangedFiles)}`, async () => {
        expect(
          (
            await classify(step, docs(150), undefined, {
              payloadChangedFiles: undefined,
              apiChangedFiles,
            })
          )[output],
        ).toBe("false");
      });
    }

    test(`${step} fails closed when the reported count is smaller than the list`, async () => {
      expect(
        (await classify(step, docs(150), undefined, { payloadChangedFiles: 100 }))[output],
      ).toBe("false");
    });
  }

  test("filter uses the event count without fetching PR details", async () => {
    expect(
      (await classify("filter", docs(150), undefined, { failPrDetails: true })).docs_only,
    ).toBe("true");
  });

  test("filter fails closed if the count fallback request fails", async () => {
    expect(
      (
        await classify("filter", docs(150), undefined, {
          payloadChangedFiles: undefined,
          failPrDetails: true,
        })
      ).docs_only,
    ).toBe("false");
  });

  test("Node unit test skip still depends on the guarded docs-only output", () => {
    expect(workflow.jobs["node-unit-tests"].if).toContain(
      "needs.detect-changes.outputs.docs_only != 'true'",
    );
  });
});
