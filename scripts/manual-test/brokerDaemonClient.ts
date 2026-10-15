import "./harnessLogSink";
import type {
  SessionBrokerReleaseResult,
  SessionBrokerResult,
} from "../../src/models/sessionBrokerResult";
import { z } from "zod";
import { toActionableError } from "../../src/models/ActionableError";
import { DAEMON_ONESHOT_CLIENT_MAX_FRAME_BYTES } from "../../src/daemon/socketServer/LineFramer";
import { defaultIdGenerator, type IdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { connectFrameSocket } from "./daemon-frame";
import {
  encodeDaemonFrame,
  LineDecoder,
  type ConnectFrameSocket,
  type FrameConnection,
} from "./frameWire";

export interface BrokerDaemonClient {
  status(requestId: string, livenessOwnerToken: string): Promise<SessionBrokerResult | undefined>;
  abandon(requestId: string, livenessOwnerToken: string): Promise<SessionBrokerResult>;
  release(sessionUuid: string, livenessOwnerToken: string): Promise<SessionBrokerReleaseResult>;
  info(sessionUuid: string): Promise<unknown>;
  capabilities(): Promise<readonly string[]>;
}
export const BROKER_CLEANUP_TIMEOUT_MS = 240_000;
const responseSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
});
const releaseSchema = z.object({
  sessionUuid: z.string(),
  outcome: z.enum(["released", "cleanup_pending", "unknown_session"]),
});
function parseResult(value: unknown, requestId: string): SessionBrokerResult {
  // The product owns the profile schema; this adapter validates the broker envelope.
  const result = value as Partial<SessionBrokerResult> | null | undefined;
  if (
    !result ||
    result.contractVersion !== 1 ||
    result.requestId !== requestId ||
    !["ready", "pending", "released", "failed"].includes(String(result.outcome)) ||
    typeof result.cleanupPending !== "boolean" ||
    !(result.sessionUuid === null || typeof result.sessionUuid === "string") ||
    !(result.profile === null || typeof result.profile === "object")
  ) {
    throw new Error("Invalid broker result envelope.");
  }
  return result as SessionBrokerResult;
}
export function createFrameBrokerDaemonClient(options: {
  socketPath: string;
  connect?: ConnectFrameSocket;
  timer?: Timer;
  ids?: IdGenerator;
}): BrokerDaemonClient {
  const timer = options.timer ?? defaultTimer;
  const connect = options.connect ?? connectFrameSocket;
  const ids = options.ids ?? defaultIdGenerator;
  const call = async (method: string, params: Record<string, unknown>, timeoutMs: number) => {
    let connection: FrameConnection | undefined;
    let finished = false;
    const close = (): void => {
      connection?.destroy();
    };
    try {
      return await raceWithDeadline(
        async () => {
          const opened = await connect(options.socketPath);
          if (finished) {
            opened.destroy();
            throw new Error("Broker connection arrived after its deadline.");
          }
          connection = opened;
          const id = ids.next();
          const decoder = new LineDecoder(DAEMON_ONESHOT_CLIENT_MAX_FRAME_BYTES, "Broker response");
          return new Promise<z.infer<typeof responseSchema>>((resolve, reject) => {
            opened.onClose((error) =>
              reject(error ?? new Error("Broker socket closed without a response.")),
            );
            opened.onData((chunk) => {
              try {
                const { lines, overflow } = decoder.push(chunk);
                for (const line of lines) {
                  const response = responseSchema.parse(JSON.parse(line));
                  if (response.id === id) {
                    resolve(response);
                    return;
                  }
                }
                if (overflow) {
                  reject(overflow);
                }
              } catch (error) {
                reject(toActionableError(error, "Invalid broker response frame."));
              }
            });
            opened.write(encodeDaemonFrame({ id, method, params, timeoutMs }));
          });
        },
        { timer, timeoutMs, label: method },
      );
    } finally {
      finished = true;
      close();
    }
  };
  const result = async (method: string, params: Record<string, unknown>, timeoutMs = 5000) => {
    const response = await call(method, params, timeoutMs);
    if (!response.success) {
      throw new Error(
        `${method}: ${response.code ?? "refused"}: ${response.error ?? "Daemon request failed"}`,
      );
    }
    return response.result;
  };
  return {
    status: async (requestId, livenessOwnerToken) => {
      const response = await call(
        "daemon/sessionRequestStatus",
        { requestId, livenessOwnerToken },
        5000,
      );
      if (!response.success && response.code === "session_request_not_found") {
        return undefined;
      }
      if (!response.success) {
        throw new Error(response.error ?? "Broker status refused.");
      }
      return parseResult(response.result, requestId);
    },
    abandon: async (requestId, livenessOwnerToken) =>
      parseResult(
        await result(
          "daemon/abandonSessionRequest",
          { requestId, livenessOwnerToken },
          BROKER_CLEANUP_TIMEOUT_MS,
        ),
        requestId,
      ),
    release: async (sessionId, livenessOwnerToken) => {
      const receipt = releaseSchema.parse(
        await result(
          "daemon/releaseBrokerSession",
          { sessionId, livenessOwnerToken },
          BROKER_CLEANUP_TIMEOUT_MS,
        ),
      );
      if (receipt.sessionUuid !== sessionId) {
        throw new Error("Broker release session mismatch.");
      }
      return receipt;
    },
    info: async (sessionId) => {
      const sessionSchema = z
        .object({
          sessionId: z.literal(sessionId),
          assignedDevice: z.string(),
          platform: z.enum(["android", "ios"]),
        })
        .passthrough();
      const info = sessionSchema.parse(await result("daemon/sessionInfo", { sessionId }));
      // sessionInfo currently returns only the serial/UDID. Resolve its name through the
      // same daemon inventory used by the batch devices view, never a native host probe.
      const envelope = z
        .object({
          isError: z.boolean().optional(),
          structuredContent: z.unknown().optional(),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
        })
        .parse(await result("tools/call", { name: "listDevices", arguments: {} }));
      if (envelope.isError) {
        throw new Error("Broker native device inventory refused.");
      }
      const payload =
        envelope.structuredContent ??
        JSON.parse(envelope.content?.find((item) => item.type === "text")?.text ?? "null");
      const inventory = z
        .object({
          devices: z.array(
            z.object({
              name: z.string().min(1),
              platform: z.enum(["android", "ios"]),
              runtime: z.object({ deviceId: z.string().nullable() }),
            }),
          ),
        })
        .parse(payload);
      const matches = inventory.devices.filter(
        (device) =>
          device.runtime.deviceId === info.assignedDevice && device.platform === info.platform,
      );
      if (matches.length !== 1) {
        throw new Error("Broker native device name is missing or ambiguous.");
      }
      // Do not bind a recycled serial if release raced the inventory lookup.
      const current = sessionSchema.parse(await result("daemon/sessionInfo", { sessionId }));
      if (current.assignedDevice !== info.assignedDevice || current.platform !== info.platform) {
        throw new Error("Broker native device binding changed during info.");
      }
      return {
        ...info,
        nativeDevice: {
          name: matches[0].name,
          deviceId: info.assignedDevice,
          platform: info.platform,
        },
      };
    },
    capabilities: async () =>
      z.object({ capabilities: z.array(z.string()) }).parse(await result("daemon/capabilities", {}))
        .capabilities,
  };
}

/** One deadline covers RPC time as well as sleeps; absence is never a cleanup receipt. */
export async function waitForBrokerRelease(options: {
  client: BrokerDaemonClient;
  requestId: string;
  token: string;
  timer: Timer;
  requireReleased?: boolean;
  timeoutMs?: number;
}): Promise<SessionBrokerResult> {
  const timeoutMs = options.timeoutMs ?? BROKER_CLEANUP_TIMEOUT_MS;
  const deadline = options.timer.now() + timeoutMs;
  return raceWithDeadline(
    async () => {
      while (options.timer.now() < deadline) {
        const status = await options.client.status(options.requestId, options.token);
        if (
          status &&
          !status.cleanupPending &&
          (!options.requireReleased || status.outcome === "released")
        ) {
          return status;
        }
        await options.timer.sleep(Math.min(250, Math.max(0, deadline - options.timer.now())));
      }
      throw new Error("Timed out waiting for broker release receipt.");
    },
    { timer: options.timer, timeoutMs, label: "Broker release receipt" },
  );
}
