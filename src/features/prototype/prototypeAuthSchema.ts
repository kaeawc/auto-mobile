import { z } from "zod";
import { prototypeContractPatterns } from "./prototypeContractPatterns";

/** One fake account (#14303): an id, a display name and a reserved-domain email; no secrets. */
function authAccountSchema() {
  return z
    .object({
      id: z.string().max(64).regex(prototypeContractPatterns.stateKey),
      name: z.string().min(1).max(64),
      email: z
        .string()
        .max(254)
        .regex(prototypeContractPatterns.reservedEmail)
        .describe("Reserved domain only: example.test, example.com or *.invalid"),
      avatar: z.string().max(64).regex(prototypeContractPatterns.stateKey).optional(),
    })
    .strict();
}

/**
 * Root `auth` block for the fake identity provider; needs `auth` in `requires.platform`. Built per
 * call so the advertised JSON schema inlines it instead of emitting a shared `$ref`.
 */
export function prototypeAuthSchema() {
  return z
    .object({
      provider: z.literal("fake"),
      accounts: z.array(authAccountSchema()).min(1).max(8),
      sessionTtlSeconds: z.number().finite().int().min(60).max(2592000).optional(),
    })
    .strict()
    .describe(
      "Fake sign-in accounts for auth.signIn (prototype_platform_auth_v1); unique ids, no passwords or tokens",
    );
}
