/**
 * The connect callback of a `net.createConnection` call. Node overloads the call as
 * (options, cb), (port, host, cb) and (path, cb), so a spy that accepts every overload
 * takes `...args: unknown[]` and recovers the listener here.
 */
export function connectionListenerOf(args: readonly unknown[]): (() => void) | undefined {
  return args.find((arg): arg is () => void => typeof arg === "function");
}
