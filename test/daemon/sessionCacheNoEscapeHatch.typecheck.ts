import type { SessionCacheData } from "../../src/daemon/sessionManager";

/**
 * Compile-time guard for issue #2973 (replaces regex scans of the interface body, #11867):
 * `SessionCacheData` has typed `keepScreenAwake` / `deviceLabels` slots and no untyped
 * `customData` / `Record<string, any>` escape hatch. `bun run typecheck` fails on a
 * missing `@ts-expect-error` (unused directive) or a failed assignment.
 */

// EC1: the typed slots exist with their dedicated types (assignment fails if retyped to any/unknown-free).
type KeepAwake = NonNullable<SessionCacheData["keepScreenAwake"]>;
type DeviceLabels = NonNullable<SessionCacheData["deviceLabels"]>;
declare const keepAwake: KeepAwake;
declare const labels: DeviceLabels;
const typedSlots: SessionCacheData = { keepScreenAwake: keepAwake, deviceLabels: labels };
// @ts-expect-error A typed slot rejects an unrelated value (fails if the slot became `any`).
const wrongKeepAwake: SessionCacheData = { keepScreenAwake: 42 };

// EC2: no `customData` bag, and no string index signature (`Record<string, any>`).
// @ts-expect-error `customData` is not a SessionCacheData member.
type CustomData = SessionCacheData["customData"];
// @ts-expect-error An excess `customData` key is rejected on the literal.
const withBag: SessionCacheData = { customData: {} };
const noIndexSignature: string extends keyof SessionCacheData ? never : true = true;

// EC7: reading `.customData` off a cache is a compile error, so no consumer can fish keys out of it.
declare const cache: SessionCacheData;
// @ts-expect-error No `customData` member to read.
const bag = cache.customData;

void [typedSlots, wrongKeepAwake, withBag, noIndexSignature, bag];
export type { CustomData };
