import type {
  SessionBrokerReleaseResult,
  SessionBrokerResult,
} from "../../src/models/sessionBrokerResult";

/** Optional daemon RPC port. Step 5 supplies the frame-wire adapter and lifecycle operations. */
export interface BrokerDaemonClient {
  status(requestId: string, livenessOwnerToken: string): Promise<SessionBrokerResult | undefined>;
  abandon(requestId: string, livenessOwnerToken: string): Promise<SessionBrokerResult>;
  release(sessionUuid: string, livenessOwnerToken: string): Promise<SessionBrokerReleaseResult>;
  info(sessionUuid: string): Promise<unknown>;
  capabilities(): Promise<readonly string[]>;
}
