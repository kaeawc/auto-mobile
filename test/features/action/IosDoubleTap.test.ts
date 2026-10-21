import { expect, mock, test } from "bun:test";
import {
  type IosCoordinateTapClient,
  dispatchIosDoubleTap,
} from "../../../src/features/action/coordinateTapDispatch";

for (const outcome of ["success", "refusal", "unanswered", "aborted"] as const) {
  test(`atomic iOS double tap: ${outcome}`, async () => {
    const single = mock(async () => ({ success: true }));
    const double = mock<IosCoordinateTapClient["requestDoubleTapCoordinates"]>(
      async (_x, _y, _timeout, _frame, _signal, onDispatch) => {
        onDispatch?.();
        return {
          success: outcome === "success",
          error: "refused",
          dispatched: true,
          acknowledged: outcome !== "unanswered",
        };
      },
    );
    const controller = new AbortController();
    if (outcome === "aborted") {
      controller.abort(new Error("cancelled"));
    }
    const result = dispatchIosDoubleTap(
      { requestTapCoordinates: single, requestDoubleTapCoordinates: double },
      1,
      2,
      50,
      "frame",
      { signal: controller.signal },
    );
    if (outcome === "success") {
      await result;
    } else {
      await expect(result).rejects.toThrow(
        outcome === "aborted"
          ? "cancelled"
          : outcome === "refusal"
            ? "double tap failed"
            : "indeterminate",
      );
    }
    expect(single).toHaveBeenCalledTimes(0);
    expect(double).toHaveBeenCalledTimes(outcome === "aborted" ? 0 : 1);
  });
}
