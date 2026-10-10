import { FakeSlotRegistry } from "./FakeSlotRegistry";
import { describeSlotRegistryContract } from "../daemon/managedSlots/slotRegistryContract";

describeSlotRegistryContract("FakeSlotRegistry", async (timer, isExecOwnerLive) => {
  return new FakeSlotRegistry(timer, isExecOwnerLive);
});
