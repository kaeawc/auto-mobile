import type {
  EgressPolicy,
  HostResolver,
} from "../../src/features/prototype/prototypeEgressPolicy";

/** Explicit local-fixture opt-in; production always constructs the strict policy. */
export const permissivePrototypeEgressPolicy: EgressPolicy = {
  permitsHostname: () => true,
  permitsAddress: () => true,
};

export const fakePublicHostResolver: HostResolver = async () => [{ address: "8.8.8.8", family: 4 }];
