import type {
  HostLoopbackProbe,
  HostLoopbackState,
} from "../../src/features/portReverse/HostLoopbackProbe";

/** Host loopback ports and what a connect to each shows; unlisted ports are refused. */
export class FakeHostLoopbackProbe implements HostLoopbackProbe {
  readonly states = new Map<number, HostLoopbackState>();
  readonly probed: number[] = [];
  /** Runs when a port is probed, to simulate the device changing meanwhile. */
  onProbe?: (port: number) => void;

  async probe(port: number): Promise<HostLoopbackState> {
    this.probed.push(port);
    this.onProbe?.(port);
    return this.states.get(port) ?? "refused";
  }
}
