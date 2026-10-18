import type WebSocket from "ws";
import type { ViewHierarchyResult } from "../../../../src/models";
import { WebSocketState } from "../../../fakes/FakeWebSocket";
import { createHierarchyForTest } from "../observeScreenTestBuilders";
import type { XCTestHierarchy } from "../../../../src/features/observe/ios/types";

/**
 * Observation-stream tests drive geometry tracking with only the fields a
 * test sets (mostly screen metadata); the rest of the runner payload is irrelevant to them.
 * This is the single widening point from that subset to the full payload type.
 */
export function createIosScreenSourceForTest(
  fields: Partial<XCTestHierarchy> = {},
): XCTestHierarchy {
  // Deliberately partial runner payload: only the fields a test sets are read.
  return fields as XCTestHierarchy;
}

/** Empty converted hierarchy forwarded to the observation stream. */
export function emptyViewHierarchyForTest(): ViewHierarchyResult {
  return createHierarchyForTest({ hierarchy: {} });
}

/**
 * An open socket that only implements `send`, for gesture tests whose client
 * code writes a request and reads nothing else from the socket.
 */
export function createSendOnlyWebSocketForTest(send: (data: string) => void): WebSocket {
  // Deliberately partial: the code under test touches only readyState and send.
  return { readyState: WebSocketState.OPEN, send } as WebSocket;
}

/**
 * Raw runner root: the converter also accepts un-normalised wire nodes (bare
 * `class`/`node` fields) that `CtrlProxyNode` does not declare.
 */
export function createRawRunnerHierarchyForTest(
  fields: Partial<Omit<ViewHierarchyResult, "hierarchy">> & { hierarchy: Record<string, unknown> },
): ViewHierarchyResult {
  // Deliberately loose wire shape; the code under test, not the type, normalises it.
  return fields as ViewHierarchyResult;
}

/** A converted result that carries only the runner hierarchy, for ordering stubs. */
export function createConvertedHierarchyStubForTest(
  runner: Pick<XCTestHierarchy, "hierarchy">,
): ViewHierarchyResult {
  // Deliberately incomplete: ordering tests never read the other fields.
  return runner as ViewHierarchyResult;
}

/**
 * An iOS-shaped converted hierarchy: iOS nodes nest attributes in `$`, which
 * the Android-flat `ViewHierarchyNode` type does not model.
 */
export function createLayoutHierarchyForTest(fixture: {
  hierarchy: { node: Array<{ $: Record<string, unknown> }> };
  packageName: string;
  windows: unknown[];
  updatedAt: number;
}): ViewHierarchyResult {
  // Deliberate iOS `$`-attribute nodes (and unserialisable values) exercise telemetry guards.
  return fixture as ViewHierarchyResult;
}
