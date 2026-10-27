import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";

/**
 * Reading or assembling the receipt failed after activation committed. The active grant stays
 * intact and is not routed through acquisition rollback; the caller receives an RPC error and a
 * replay of the same request identity reads the committed receipt.
 */
export class CommittedReceiptReadError extends ActionableError {
  constructor(requestId: string, cause: unknown) {
    super(
      `Session request ${requestId} committed its session, but its receipt could not be read ` +
        `(${errorMessage(cause)}); replay the same request ID to recover it`,
      { cause },
    );
  }
}
