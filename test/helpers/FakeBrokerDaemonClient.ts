import type { BrokerDaemonClient } from "../../scripts/manual-test/brokerDaemonClient";
import type {
  SessionBrokerReleaseResult,
  SessionBrokerResult,
} from "../../src/devices/sessionBrokerResult";

type Reply<T> = T | Error;
/** Scripted queues retain their last reply for repeated status polls. */
export class FakeBrokerDaemonClient implements BrokerDaemonClient {
  readonly calls: Array<{ method: keyof BrokerDaemonClient; args: string[] }> = [];
  statusResults: Reply<SessionBrokerResult | undefined>[] = [undefined];
  abandonResults: Reply<SessionBrokerResult>[] = [];
  releaseResults: Reply<SessionBrokerReleaseResult>[] = [];
  infoResults: Reply<unknown>[] = [];
  capabilityResults: Reply<readonly string[]>[] = [["session-broker/v1"]];
  private next<T>(method: keyof BrokerDaemonClient, args: string[], replies: Reply<T>[]): T {
    this.calls.push({ method, args });
    if (!replies.length) {
      throw new Error(`No scripted ${method} reply.`);
    }
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
  async status(...args: [string, string]): Promise<SessionBrokerResult | undefined> {
    return this.next("status", args, this.statusResults);
  }
  async abandon(...args: [string, string]): Promise<SessionBrokerResult> {
    return this.next("abandon", args, this.abandonResults);
  }
  async release(...args: [string, string]): Promise<SessionBrokerReleaseResult> {
    return this.next("release", args, this.releaseResults);
  }
  async info(sessionUuid: string): Promise<unknown> {
    return this.next("info", [sessionUuid], this.infoResults);
  }
  async capabilities(): Promise<readonly string[]> {
    return this.next("capabilities", [], this.capabilityResults);
  }
}
