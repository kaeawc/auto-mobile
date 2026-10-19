export type ForeignCtrlProxyForwardVerdict =
  | { kind: "none" }
  | { kind: "foreign"; ports: number[]; clientPids: number[]; message: string }
  | { kind: "unknown"; ports: number[]; reason: string; message: string };

export interface ForeignCtrlProxyForwardEvidence {
  /** Never mutates the device or the host. */
  read(deviceId: string, signal?: AbortSignal): Promise<ForeignCtrlProxyForwardVerdict>;
}
