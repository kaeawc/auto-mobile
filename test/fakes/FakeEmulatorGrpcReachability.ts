import type {
  EmulatorGrpcReachability,
  GrpcReachabilityState,
} from "../../src/utils/audio/emulatorGrpcReachability";

export class FakeEmulatorGrpcReachability implements EmulatorGrpcReachability {
  readonly calls: { address: string; deadlineMs: number }[] = [];
  result: GrpcReachabilityState = { state: "reachable" };
  pending?: Promise<GrpcReachabilityState>;

  async connect(address: string, deadlineMs: number): Promise<GrpcReachabilityState> {
    this.calls.push({ address, deadlineMs });
    return this.pending ?? this.result;
  }
}
