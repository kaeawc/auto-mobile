import { afterEach, describe, expect, test } from "bun:test";
import { serverConfig } from "../../src/utils/ServerConfig";

/**
 * EC1: each output-reduction flag defaults off and its setter flips the getter.
 * Restores defaults after each test so the shared singleton doesn't leak state.
 */
describe("ServerConfig output-reduction flags", () => {
  afterEach(() => {
    serverConfig.setObserveResultDropElementsEnabled(false);
    serverConfig.setObserveResultCompactEnabled(false);
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    serverConfig.setActionsDiffObserveEnabled(false);
    serverConfig.setActionsNoObserveEnabled(false);
    serverConfig.setToolResultsCompactJsonEnabled(false);
    serverConfig.setToolOutputArtifactDirectory(undefined);
  });

  test("observe-result-drop-elements defaults off and toggles", () => {
    expect(serverConfig.isObserveResultDropElementsEnabled()).toBe(false);
    serverConfig.setObserveResultDropElementsEnabled(true);
    expect(serverConfig.isObserveResultDropElementsEnabled()).toBe(true);
  });

  test("observe-result-compact defaults off and toggles", () => {
    expect(serverConfig.isObserveResultCompactEnabled()).toBe(false);
    serverConfig.setObserveResultCompactEnabled(true);
    expect(serverConfig.isObserveResultCompactEnabled()).toBe(true);
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

  test("actions-no-observe defaults off and toggles", () => {
    expect(serverConfig.isActionsNoObserveEnabled()).toBe(false);
    serverConfig.setActionsNoObserveEnabled(true);
    expect(serverConfig.isActionsNoObserveEnabled()).toBe(true);
  });

  test("tool-results-compact-json defaults off and toggles", () => {
    expect(serverConfig.isToolResultsCompactJsonEnabled()).toBe(false);
    serverConfig.setToolResultsCompactJsonEnabled(true);
    expect(serverConfig.isToolResultsCompactJsonEnabled()).toBe(true);
  });

  test("tool-output artifact directory defaults off and toggles", () => {
    expect(serverConfig.isToolOutputArtifactModeEnabled()).toBe(false);
    expect(serverConfig.getToolOutputArtifactDirectory()).toBeUndefined();

    serverConfig.setToolOutputArtifactDirectory("/tmp/artifacts");

    expect(serverConfig.isToolOutputArtifactModeEnabled()).toBe(true);
    expect(serverConfig.getToolOutputArtifactDirectory()).toBe("/tmp/artifacts");
  });
});
