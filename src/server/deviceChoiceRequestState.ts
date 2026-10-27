import { createRequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { MCP_SESSION_KEY_HEADER, readMcpSessionKey } from "../daemon/mcpSessionKey";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

export const deviceChoiceRequestStateSchema = z.object({
  version: z.literal(1),
  toolName: z.string(),
  argumentsHash: z.string(),
  deviceIds: z.array(z.string()),
});

export type DeviceChoiceRequestState = z.infer<typeof deviceChoiceRequestStateSchema>;

export interface DeviceChoiceRequestStateCodec {
  mint(payload: DeviceChoiceRequestState, ctx: ServerContext): Promise<string>;
  verify(state: string, ctx: ServerContext): Promise<DeviceChoiceRequestState>;
}

/** Random/IdGenerator expose no byte primitive; keep cryptographic key generation injectable. */
export interface RequestStateSecretProvider {
  createSecret(): Uint8Array;
}

const defaultSecretProvider: RequestStateSecretProvider = {
  createSecret: () => crypto.getRandomValues(new Uint8Array(32)),
};
const REQUEST_STATE_TTL_MS = 10 * 60 * 1000;
const sealedStateSchema = deviceChoiceRequestStateSchema.extend({ expiresAt: z.number().finite() });

function sessionBinding(ctx: ServerContext): string {
  const sessionKey = readMcpSessionKey({
    [MCP_SESSION_KEY_HEADER]: ctx.http?.req?.headers.get(MCP_SESSION_KEY_HEADER) ?? undefined,
  });
  return JSON.stringify(["ambiguous-device", sessionKey ?? null]);
}

/** Lazy process-lifetime key, shared across the daemon's per-request servers. */
export function createDeviceChoiceRequestStateCodec(
  options: {
    timer?: Pick<Timer, "now">;
    secretProvider?: RequestStateSecretProvider;
  } = {},
): DeviceChoiceRequestStateCodec {
  const timer = options.timer ?? defaultTimer;
  let codec:
    | ReturnType<typeof createRequestStateCodec<z.infer<typeof sealedStateSchema>>>
    | undefined;
  const getCodec = () => {
    codec ??= createRequestStateCodec<z.infer<typeof sealedStateSchema>>({
      key: (options.secretProvider ?? defaultSecretProvider).createSecret(),
      ttlSeconds: REQUEST_STATE_TTL_MS / 1000,
      bind: sessionBinding,
    });
    return codec;
  };
  return {
    mint: (payload, ctx) =>
      getCodec().mint({ ...payload, expiresAt: timer.now() + REQUEST_STATE_TTL_MS }, ctx),
    verify: async (state, ctx) => {
      const payload = sealedStateSchema.parse(await getCodec().verify(state, ctx));
      // The SDK also enforces its wall-clock TTL; this deadline keeps our clock injectable.
      if (timer.now() >= payload.expiresAt) {
        throw new Error("expired");
      }
      return deviceChoiceRequestStateSchema.parse(payload);
    },
  };
}

export const daemonDeviceChoiceRequestState = createDeviceChoiceRequestStateCodec();
