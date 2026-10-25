import { describe, expect, test } from "bun:test";
import type { IncomingHttpHeaders } from "node:http";
import {
  DAEMON_RELEASED_SESSION_HEADER,
  DAEMON_SESSION_TOOL_BINDING_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_HEADER,
} from "../../src/daemon/wire/constants";
import {
  buildMcpRequestContext,
  type McpForwardRequestContext,
} from "../../src/daemon/statelessMcpServerFactory";

const BOUND = "11111111-2222-4333-8444-555555555555";
const RELEASED = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const PROFILE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

/**
 * The headers the loopback HTTP client sends for a forward (#11820): a header only for a
 * non-empty value, with fetch's edge-whitespace normalization, as node:http hands them over.
 */
function sentHeaders(forward: McpForwardRequestContext): IncomingHttpHeaders {
  const headers = new Headers();
  if (forward.boundSessionUuid) {
    headers.set(DAEMON_SESSION_TOOL_BINDING_HEADER, forward.boundSessionUuid);
  }
  if (forward.releasedSessionUuid) {
    headers.set(DAEMON_RELEASED_SESSION_HEADER, forward.releasedSessionUuid);
  }
  if (forward.toolSelectionProfileUuid) {
    headers.set(DAEMON_TOOL_SELECTION_PROFILE_HEADER, forward.toolSelectionProfileUuid);
  }
  return Object.fromEntries(headers.entries());
}

describe("buildMcpRequestContext (#11820)", () => {
  const forwards: Array<[string, McpForwardRequestContext]> = [
    ["no context", {}],
    ["bound only", { boundSessionUuid: BOUND }],
    ["released only", { releasedSessionUuid: RELEASED }],
    ["profile only", { toolSelectionProfileUuid: PROFILE }],
    [
      "bound and a different released session",
      { boundSessionUuid: BOUND, releasedSessionUuid: RELEASED },
    ],
    ["bound session marked released", { boundSessionUuid: BOUND, releasedSessionUuid: BOUND }],
    [
      "bound session marked released with padding",
      { boundSessionUuid: ` ${BOUND}\t`, releasedSessionUuid: BOUND },
    ],
    [
      "all three",
      { boundSessionUuid: BOUND, releasedSessionUuid: RELEASED, toolSelectionProfileUuid: PROFILE },
    ],
    [
      "empty values",
      { boundSessionUuid: "", releasedSessionUuid: "", toolSelectionProfileUuid: "" },
    ],
    [
      "blank values",
      { boundSessionUuid: "  ", releasedSessionUuid: "\t", toolSelectionProfileUuid: " " },
    ],
    [
      "padded values",
      { boundSessionUuid: `  ${BOUND} `, toolSelectionProfileUuid: `\t${PROFILE}` },
    ],
  ];

  test.each(forwards)("a forward's struct and its loopback headers agree: %s", (_name, forward) => {
    expect(buildMcpRequestContext(forward)).toEqual(
      buildMcpRequestContext({ headers: sentHeaders(forward) }),
    );
  });

  test("a bound session the caller marked released is not bound", () => {
    expect(buildMcpRequestContext({ boundSessionUuid: BOUND, releasedSessionUuid: BOUND })).toEqual(
      { initialReleasedSession: BOUND },
    );
  });

  test("a repeated header (a string array) is not a context value", () => {
    expect(
      buildMcpRequestContext({ headers: { [DAEMON_SESSION_TOOL_BINDING_HEADER]: [BOUND, BOUND] } }),
    ).toEqual({});
  });

  test("all three fields reach the context", () => {
    expect(
      buildMcpRequestContext({
        boundSessionUuid: BOUND,
        releasedSessionUuid: RELEASED,
        toolSelectionProfileUuid: PROFILE,
      }),
    ).toEqual({
      initialSessionToolBinding: BOUND,
      initialReleasedSession: RELEASED,
      initialToolSelectionProfile: PROFILE,
    });
  });
});
