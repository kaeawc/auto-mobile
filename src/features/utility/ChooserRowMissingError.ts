/** Retry signal for a missing chooser row; carries the capture time when known so paging can continue safely. */
export class ChooserRowMissingError extends Error {
  capturedAt?: number;
}
