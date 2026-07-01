import { describe, expect, test } from "bun:test";
import { parseDaemonArgs } from "../../src/daemon/manager";

/**
 * EC5: the daemon child receives each output-reduction flag as a CLI arg and
 * parseDaemonArgs (the daemon-side reader) maps it back onto DaemonOptions.
 * This is the forward half of the MCP-process -> daemon-process hand-off.
 */
describe("parseDaemonArgs output-reduction flags", () => {
  test("defaults are undefined when no flag is passed", () => {
    const options = parseDaemonArgs([]);
    expect(options.observeResultDropElements).toBeUndefined();
    expect(options.observeResultCompact).toBeUndefined();
    expect(options.toolResultsNoStructuredContent).toBeUndefined();
    expect(options.actionsDiffObserve).toBeUndefined();
    expect(options.actionsNoObserve).toBeUndefined();
  });

  test("--observe-result-drop-elements sets observeResultDropElements", () => {
    expect(parseDaemonArgs(["--observe-result-drop-elements"]).observeResultDropElements).toBe(true);
  });

  test("--observe-result-compact sets observeResultCompact", () => {
    expect(parseDaemonArgs(["--observe-result-compact"]).observeResultCompact).toBe(true);
  });

  test("--tool-results-no-structured-content sets toolResultsNoStructuredContent", () => {
    expect(parseDaemonArgs(["--tool-results-no-structured-content"]).toolResultsNoStructuredContent).toBe(true);
  });

  test("--actions-diff-observe sets actionsDiffObserve", () => {
    expect(parseDaemonArgs(["--actions-diff-observe"]).actionsDiffObserve).toBe(true);
  });

  test("--actions-no-observe sets actionsNoObserve", () => {
    expect(parseDaemonArgs(["--actions-no-observe"]).actionsNoObserve).toBe(true);
  });

  test("all output-reduction flags parse together", () => {
    const options = parseDaemonArgs([
      "--observe-result-drop-elements",
      "--observe-result-compact",
      "--tool-results-no-structured-content",
      "--actions-diff-observe",
      "--actions-no-observe",
    ]);
    expect(options.observeResultDropElements).toBe(true);
    expect(options.observeResultCompact).toBe(true);
    expect(options.toolResultsNoStructuredContent).toBe(true);
    expect(options.actionsDiffObserve).toBe(true);
    expect(options.actionsNoObserve).toBe(true);
  });
});
