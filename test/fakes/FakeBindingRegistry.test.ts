import { FakeBindingRegistry } from "./FakeBindingRegistry";
import { describeBindingRegistryContract } from "../helpers/bindingRegistryContract";

describeBindingRegistryContract("FakeBindingRegistry", async (timer, isExecOwnerLive) => {
  return new FakeBindingRegistry(timer, isExecOwnerLive);
});
