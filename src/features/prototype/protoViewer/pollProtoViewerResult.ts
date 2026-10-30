import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { Timer } from "../../../utils/SystemTimer";
import { protoViewerWireResultSchema, type ProtoViewerWireResult } from "./protoViewerContract";
import { PROTOVIEWER_RESULT_POLL_MS } from "./protoViewerDevice";
/** Empty reads mean the app has not atomically published its result yet. */
export async function pollProtoViewerResult(
  read: () => Promise<string>,
  timer: Timer,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutGuidance = "It may still have saved the prototype: check ProtoViewer before retrying, and unlock the device if it is locked.",
): Promise<ProtoViewerWireResult> {
  const deadline = timer.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const text = (await read()).trim();
    if (text.length > 0) {
      return parseResult(text);
    }
    await timer.sleep(Math.min(PROTOVIEWER_RESULT_POLL_MS, Math.max(0, deadline - timer.now())));
  } while (timer.now() < deadline);
  throw new ActionableError(
    `ProtoViewer did not answer within ${timeoutMs} ms. ${timeoutGuidance}`,
  );
}

function parseResult(text: string): ProtoViewerWireResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ActionableError(`ProtoViewer wrote an unreadable result: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const parsed = protoViewerWireResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new ActionableError(`ProtoViewer wrote an unexpected result: ${parsed.error.message}`);
  }
  return parsed.data;
}
