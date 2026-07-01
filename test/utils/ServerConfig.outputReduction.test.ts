import { afterEach, describe, expect, test } from "bun:test";
import { serverConfig } from "../../src/utils/ServerConfig";

/**
 * EC1: each output-reduction flag defaults off and its setter flips the getter.
 * Restores defaults after each test so the shared singleton doesn't leak state.
 */
describe("ServerConfig output-reduction flags", () => {
  afterEach(() => {
    serverConfig.setObserveResultDropElements(false);
    serverConfig.setObserveResultCompact(false);
    serverConfig.setToolResultsNoStructuredContent(false);
    serverConfig.setActionsDiffObserve(false);
    serverConfig.setActionsNoObserve(false);
  });

  test("observe-result-drop-elements defaults off and toggles", () => {
    expect(serverConfig.isObserveResultDropElementsEnabled()).toBe(false);
    serverConfig.setObserveResultDropElements(true);
    expect(serverConfig.isObserveResultDropElementsEnabled()).toBe(true);
  });

  test("observe-result-compact defaults off and toggles", () => {
    expect(serverConfig.isObserveResultCompactEnabled()).toBe(false);
    serverConfig.setObserveResultCompact(true);
    expect(serverConfig.isObserveResultCompactEnabled()).toBe(true);
  });

  test("tool-results-no-structured-content defaults off and toggles", () => {
    expect(serverConfig.isToolResultsNoStructuredContentEnabled()).toBe(false);
    serverConfig.setToolResultsNoStructuredContent(true);
    expect(serverConfig.isToolResultsNoStructuredContentEnabled()).toBe(true);
  });

  test("actions-diff-observe defaults off and toggles", () => {
    expect(serverConfig.isActionsDiffObserveEnabled()).toBe(false);
    serverConfig.setActionsDiffObserve(true);
    expect(serverConfig.isActionsDiffObserveEnabled()).toBe(true);
  });

  test("actions-no-observe defaults off and toggles", () => {
    expect(serverConfig.isActionsNoObserveEnabled()).toBe(false);
    serverConfig.setActionsNoObserve(true);
    expect(serverConfig.isActionsNoObserveEnabled()).toBe(true);
  });
});
