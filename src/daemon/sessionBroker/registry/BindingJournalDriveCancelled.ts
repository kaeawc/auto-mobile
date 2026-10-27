/** Internal unwind: cancellation is not a failed cleanup attempt. */
export class BindingJournalDriveCancelled extends Error {
  constructor(readonly reason: unknown) {
    super("Journal drive cancelled");
  }
}
