import type { LedgerEntry, LedgerSampleWindow } from "./BootAdmissionGate";

export class SampleWindow implements LedgerSampleWindow {
  readonly ended: LedgerEntry[] = [];

  constructor(private readonly onClose: (window: SampleWindow) => void) {}

  close(): void {
    this.onClose(this);
  }
}
