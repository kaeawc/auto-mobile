import type { InternalToolName, InternalToolPayloads } from "../../src/utils/internalToolPayloads";
import type { ToolRegistry } from "../../src/server/toolRegistry";
import type { StructuredToolResponse } from "../../src/utils/toolUtils";

// Compile-time enforcement of AC1 (issue #3222). AC1 is a *type* guarantee:
// `callInternalTyped(name, ...)` must thread the concrete payload type from
// `InternalToolPayloads` through the registry seam rather than collapse back to the
// untyped `Promise<any>` of `callInternal`. The runtime tests in
// `test/server/internalToolPayloads.test.ts` cannot pin this (bun's test runner does
// not typecheck), so the assertions live in a `*.typecheck.ts` file, which the
// `bun run typecheck` gate compiles (`tsconfig.json` include).
type IsAny<T> = 0 extends 1 & T ? true : false;

type AssertTrue<T extends true> = T;

type ResolvedTypedEnvelope = NonNullable<
  Awaited<ReturnType<typeof ToolRegistry.callInternalTyped>>
>;

export type ToolRegistryTypedSeamChecks = [
  // Fails to compile if the resolved envelope widens to `any` (the seam stopped
  // threading the payload type)...
  AssertTrue<IsAny<ResolvedTypedEnvelope> extends true ? false : true>,
  // ...or if it is no longer the concrete `StructuredToolResponse<...Payload>` envelope.
  AssertTrue<
    ResolvedTypedEnvelope extends StructuredToolResponse<InternalToolPayloads[InternalToolName]>
      ? true
      : false
  >,
];
