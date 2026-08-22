import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowDocument {
  jobs?: Record<string, { env?: Record<string, string>; steps?: WorkflowStep[] }>;
}

const workflows = [".github/workflows/pull_request.yml", ".github/workflows/merge.yml"];
const entrypointSource = readFileSync("src/index.ts", "utf8");
const daemonSource = readFileSync("src/daemon/daemon.ts", "utf8");

function installerDevelopmentSteps(path: string): WorkflowStep[] {
  const workflow = load(readFileSync(path, "utf8")) as WorkflowDocument;
  return workflow.jobs?.["installer-development"]?.steps ?? [];
}

function installerDevelopmentEnv(path: string): Record<string, string> {
  const workflow = load(readFileSync(path, "utf8")) as WorkflowDocument;
  return workflow.jobs?.["installer-development"]?.env ?? {};
}

describe("#4631 installer startup diagnostics", () => {
  test("records module loading before the first awaited startup import", () => {
    const mainStart = entrypointSource.indexOf("async function main()");
    const processEntryMark = entrypointSource.indexOf(
      'startupBenchmark.mark("processEntry")',
      mainStart,
    );
    const moduleImportsStart = entrypointSource.indexOf(
      'startupBenchmark.startPhase("moduleImports")',
      mainStart,
    );
    const firstDynamicImport = entrypointSource.indexOf("await import(", mainStart);
    const moduleImportsEnd = entrypointSource.indexOf(
      'startupBenchmark.endPhase("moduleImports")',
      firstDynamicImport,
    );

    expect(mainStart).toBeGreaterThanOrEqual(0);
    expect(processEntryMark).toBeGreaterThan(mainStart);
    expect(moduleImportsStart).toBeGreaterThan(processEntryMark);
    expect(firstDynamicImport).toBeGreaterThan(moduleImportsStart);
    expect(moduleImportsEnd).toBeGreaterThan(firstDynamicImport);
  });

  test("keeps auxiliary socket startup active until every server is ready", () => {
    const socketStartsBegin = daemonSource.indexOf("await startVideoRecordingSocketServer()");
    const socketStartsEnd = daemonSource.indexOf("await startVideoStreamSocketServer()");
    const phaseStart = daemonSource.lastIndexOf(
      'startupBenchmark.startPhase("auxiliarySocketServerStart")',
      socketStartsBegin,
    );
    const phaseEnd = daemonSource.indexOf(
      'startupBenchmark.endPhase("auxiliarySocketServerStart")',
      socketStartsEnd,
    );

    expect(socketStartsBegin).toBeGreaterThanOrEqual(0);
    expect(socketStartsEnd).toBeGreaterThan(socketStartsBegin);
    expect(phaseStart).toBeGreaterThanOrEqual(0);
    expect(phaseStart).toBeLessThan(socketStartsBegin);
    expect(phaseEnd).toBeGreaterThan(socketStartsEnd);
  });

  for (const workflowPath of workflows) {
    test(`${workflowPath} gives the development installer a bounded cold-start policy and preserves diagnostics`, () => {
      const steps = installerDevelopmentSteps(workflowPath);
      expect(steps.length).toBeGreaterThan(0);
      expect(installerDevelopmentEnv(workflowPath)).toMatchObject({
        AUTOMOBILE_LOG_DIR: "${{ github.workspace }}/ci-logs/daemon-logs",
      });

      const sourceCli = steps.find(
        (step) => step.name === "Build source CLI for installer diagnostics",
      );
      expect(sourceCli).toMatchObject({
        uses: "./.github/actions/setup-auto-mobile-npm-package",
        with: { "install-global": "false" },
      });

      const installer = steps.find((step) => step.name === "Run Installer (development)");
      expect(installer?.env).toMatchObject({
        AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS: "30000",
        AUTOMOBILE_STARTUP_BENCHMARK: "1",
        AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT:
          "${{ github.workspace }}/ci-logs/installer-daemon-startup.json",
        AUTOMOBILE_CLI_PATH: "${{ github.workspace }}/dist/src/index.js",
      });
      expect(installer?.run).toContain("ci-logs/ctrl-proxy-cache-state.txt");

      const upload = steps.find((step) => step.name === "Upload Logs");
      expect(upload?.with?.path).toBe("ci-logs/");
    });
  }
});
