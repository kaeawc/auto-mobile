import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  pointerSchema,
  prototypeDataActionValueSchema,
  stateKeySchema,
} from "./prototypeActionValues";

/**
 * The platform vocabulary (#14294): the `platform` action, the root `requires` block and the root
 * `platform.on` event handlers. The contract (`schemas/prototype-spec-contract.json`,
 * `definitions.action.variants.platform`, `platformRequires`, `platformHandlers` and the
 * `platformModules` table) is the shared definition; this is its Zod mirror. Rules the contract
 * cannot express (known calls and events, per-call arguments, declared modules and permissions,
 * `{event}` scope, `into`, `statusKey`) live in `prototypePlatform.ts`.
 */

/** A call argument: a data-action value binding, a `{platform}` read or, in a handler, `{event}`. */
export const prototypePlatformBindingSchema = z.union([
  ...prototypeDataActionValueSchema.options,
  z.object({ platform: pointerSchema }).strict(),
  z.object({ event: pointerSchema }).strict(),
]);
export type PrototypePlatformBinding = z.infer<typeof prototypePlatformBindingSchema>;

// Zod cannot name the union it is part of, so follow-up lists are bound after the action union
// exists, the same way the request action's are.
let followUps: (() => z.ZodTypeAny) | undefined;
export function bindPrototypePlatformFollowUps(actionSchema: () => z.ZodTypeAny): void {
  followUps = actionSchema;
}
const followUpSchema = z.lazy((): z.ZodTypeAny => (followUps ? followUps() : z.never()));
const actionList = z.array(followUpSchema).min(1).max(32);

export const platformActionSchema = z
  .object({
    type: z.enum(["platform"]),
    call: z.string().min(1).max(64),
    args: z
      .record(z.string().min(1), prototypePlatformBindingSchema)
      .refine((args) => Object.keys(args).length <= contract.limits.MAX_PROTOTYPE_PLATFORM_ARGS)
      .optional(),
    into: z
      .string()
      .min(1)
      .max(contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH + 5)
      .optional(),
    statusKey: stateKeySchema.optional(),
    timeoutMs: z
      .number()
      .finite()
      .int()
      .min(1)
      .max(contract.limits.MAX_PROTOTYPE_PLATFORM_TIMEOUT_MS)
      .optional(),
    onSuccess: actionList.optional(),
    onError: actionList.optional(),
  })
  .strict();

const permissionNames = contract.definitions.platformPermission.fields.name.rule.values as [
  string,
  ...string[],
];
const backgroundNames = contract.definitions.platformRequires.fields.background.rule.item
  .values as [string, ...string[]];

export const prototypeRequiresSchema = z
  .object({
    platform: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
    permissions: z
      .array(
        z
          .object({
            name: z.enum(permissionNames),
            purpose: z
              .string()
              .max(512)
              .refine((purpose) => !prototypeContractPatterns.blankText.test(purpose)),
          })
          .strict(),
      )
      .min(1)
      .max(16)
      .optional(),
    background: z.array(z.enum(backgroundNames)).min(1).max(8).optional(),
  })
  .strict();
export type PrototypeRequires = z.infer<typeof prototypeRequiresSchema>;

export const prototypePlatformHandlersSchema = z
  .object({
    on: z
      .record(z.string().min(1), actionList)
      .refine(
        (handlers) =>
          Object.keys(handlers).length <= contract.limits.MAX_PROTOTYPE_PLATFORM_HANDLERS,
      ),
  })
  .strict();
