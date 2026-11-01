/**
 * First and last host TCP ports tried for an emulator's gRPC endpoint. The first is the
 * emulator's own default, so a stock layout keeps the port it already uses. Console and ADB
 * ports (5554-5683) never overlap this range.
 */
export const EMULATOR_GRPC_PORT_FIRST = 8554;
export const EMULATOR_GRPC_PORT_LAST = 8653;

/**
 * True when the caller already passes `-grpc <port>` or `-grpc=<port>`. `-grpc-use-token` is a
 * different flag and does not count, so such a launch still gets a port.
 */
export function hasEmulatorGrpcArgument(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-grpc" || arg.startsWith("-grpc="));
}
