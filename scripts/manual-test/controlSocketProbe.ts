// Harness scripts deliberately never import the product logger (harnessLogSink.ts explains why); the returned reason is the trace.
import {
  DAEMON_CLIENT_MAX_FRAME_BYTES,
  DAEMON_ONESHOT_CLIENT_MAX_FRAME_BYTES,
} from "../../src/daemon/wire/LineFramer";
import { z } from "zod";
import { debuglog } from "node:util";
import type { Timer } from "../../src/utils/SystemTimer";
import type { IdGenerator } from "../../src/utils/IdGenerator";
import { errorMessage } from "../../src/utils/describeUnknownError";
import {
  encodeDaemonFrame,
  LineDecoder,
  type ConnectFrameSocket,
  type FrameConnection,
} from "./frameWire";

const debug = debuglog("automobile-manual-test");

/** Pure capability response, even before initialization: daemonRequestHandlers.ts. */
export const CONTROL_SOCKET_PROBE_METHOD = "daemon/capabilities";
export type ControlSocketProbeResult =
  | { alive: true; result?: unknown }
  | { alive: false; reason: string };
const responseSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
});
export async function probeControlSocket(
  socketPath: string,
  deps: { connect: ConnectFrameSocket; timer: Timer; ids: IdGenerator },
  options: {
    timeoutMs?: number;
    method?: string;
    maxFrameBytes?: number;
    requireCapability?: string;
  } = {},
): Promise<ControlSocketProbeResult> {
  let connection: FrameConnection | undefined;
  let settled = false;
  return new Promise<ControlSocketProbeResult>((resolve) => {
    const finish = (result: ControlSocketProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      deps.timer.clearTimeout(deadline);
      if (connection) {
        closeConnection(connection);
      }
      resolve(result);
    };
    const deadline = deps.timer.setTimeout(
      () => finish({ alive: false, reason: "Control socket probe timed out" }),
      options.timeoutMs ?? 2000,
    );
    const open = async (): Promise<void> => {
      try {
        connection = await deps.connect(socketPath);
        if (settled) {
          closeConnection(connection);
          return;
        }
        const id = deps.ids.next();
        // Capabilities is a small scalar/list answer (1 MiB). availableDevices includes
        // an uncapped inventory/stats list; other explicit methods use the 256 MiB client budget.
        const maxFrameBytes =
          options.maxFrameBytes ??
          (options.method === undefined || options.method === CONTROL_SOCKET_PROBE_METHOD
            ? DAEMON_ONESHOT_CLIENT_MAX_FRAME_BYTES
            : DAEMON_CLIENT_MAX_FRAME_BYTES);
        const decoder = new LineDecoder(maxFrameBytes, "Control probe response");
        connection.onClose((error) =>
          finish({
            alive: false,
            reason: error ? errorMessage(error) : "Control socket closed without a response",
          }),
        );
        connection.onData((chunk) => {
          if (settled) {
            return;
          }
          const { lines, overflow } = decoder.push(chunk);
          for (const line of lines) {
            try {
              const response = responseSchema.safeParse(JSON.parse(line));
              if (response.success && response.data.id === id) {
                const capabilities = z
                  .object({ capabilities: z.array(z.string()) })
                  .safeParse(response.data.result);
                if (
                  options.requireCapability &&
                  (!response.data.success ||
                    !capabilities.success ||
                    !capabilities.data.capabilities.includes(options.requireCapability))
                ) {
                  finish({
                    alive: false,
                    reason: `Required capability ${options.requireCapability} is unavailable`,
                  });
                } else {
                  finish({ alive: true, result: response.data.result });
                }
              }
            } catch (error) {
              // Non-JSON lines cannot prove a matching daemon response.
              debug(`Ignoring invalid control probe frame: ${errorMessage(error)}`);
            }
          }
          if (overflow) {
            finish({ alive: false, reason: errorMessage(overflow) });
          }
        });
        connection.write(
          encodeDaemonFrame({ id, method: options.method ?? CONTROL_SOCKET_PROBE_METHOD }),
        );
      } catch (error) {
        // Connection refusal is an expected diagnostic outcome.
        finish({ alive: false, reason: errorMessage(error) });
      }
    };
    void open();
  });
}
function closeConnection(connection: FrameConnection): void {
  try {
    connection.end();
  } catch (error) {
    // Graceful close can fail when the diagnostic socket has already gone away.
    debug(`Control probe end failed: ${errorMessage(error)}`);
  }
  try {
    // End alone half-closes a net.Socket; destroy bounds cleanup even if its peer never closes.
    connection.destroy();
  } catch (error) {
    // Transport cleanup failure must not throw out of a status probe.
    debug(`Control probe destroy failed: ${errorMessage(error)}`);
  }
}
