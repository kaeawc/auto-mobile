import type { Session } from "./sessionManager";

/**
 * What one acquisition created, filled in by the pool while it binds. A caller whose result never
 * reaches its client hands it back to `DevicePool.releaseUndeliveredAcquisition`, which takes back
 * exactly this and nothing a reused or rebound session already owned (#11565).
 */
export interface AcquisitionReceipt {
  /** The session this acquisition minted. Absent when it reused or rebound an existing one. */
  minted?: { readonly session: Session; readonly deviceId: string };
}

/** The caller's receipt, or a private one for an acquisition whose caller keeps none. */
export function receiptOrNew(receipt: AcquisitionReceipt | undefined): AcquisitionReceipt {
  return receipt ?? {};
}
