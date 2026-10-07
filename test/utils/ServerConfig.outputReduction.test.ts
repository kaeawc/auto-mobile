import { afterEach, describe, expect, test } from "bun:test";
import { serverConfig } from "../../src/utils/ServerConfig";

/**
 * EC1: compact metadata defaults on; other flags default off and its setter flips the getter.
 * Restores defaults after each test so the shared singleton doesn't leak state.
 */
describe("ServerConfig output-reduction flags", () => {
  afterEach(() => {
    serverConfig.setObserveResultIncludeElementsEnabled(false);
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    serverConfig.setActionsDiffObserveEnabled(false);
    serverConfig.setActionsNoObserveEnabled(false);
    serverConfig.setActionsCompactMetadataEnabled(true);
    serverConfig.setToolOutputsDir(undefined);
  });

  test("observe-result-include-elements defaults off and toggles", () => {
    expect(serverConfig.isObserveResultIncludeElementsEnabled()).toBe(false);
    serverConfig.setObserveResultIncludeElementsEnabled(true);
    expect(serverConfig.isObserveResultIncludeElementsEnabled()).toBe(true);
  });

  test("tool-results-no-structured-content defaults off and toggles", () => {
    expect(serverConfig.isToolResultsNoStructuredContentEnabled()).toBe(false);
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    expect(serverConfig.isToolResultsNoStructuredContentEnabled()).toBe(true);
  });

  test("actions-diff-observe defaults off and toggles", () => {
    expect(serverConfig.isActionsDiffObserveEnabled()).toBe(false);
    serverConfig.setActionsDiffObserveEnabled(true);
    expect(serverConfig.isActionsDiffObserveEnabled()).toBe(true);
  });

  test("compact metadata defaults on and opts out", () => {
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(true);
    serverConfig.setActionsCompactMetadataEnabled(false);
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(false);
  });

  test("actions-no-observe defaults off and toggles", () => {
    expect(serverConfig.isActionsNoObserveEnabled()).toBe(false);
    serverConfig.setActionsNoObserveEnabled(true);
    expect(serverConfig.isActionsNoObserveEnabled()).toBe(true);
  });

  test("tool-output artifact directory defaults off and toggles", () => {
    expect(serverConfig.isToolOutputArtifactModeEnabled()).toBe(false);
    expect(serverConfig.getToolOutputsDir()).toBeUndefined();

    serverConfig.setToolOutputsDir("/tmp/artifacts");

    expect(serverConfig.isToolOutputArtifactModeEnabled()).toBe(true);
    expect(serverConfig.getToolOutputsDir()).toBe("/tmp/artifacts");
  });
});
