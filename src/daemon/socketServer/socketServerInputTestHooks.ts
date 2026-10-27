import type { SocketInput } from "../socketServerParts/SocketInput";
import type { SocketTextInput } from "../socketServerParts/SocketTextInput";
import type { SocketServerOperations } from "../socketServerParts/socketServerOperations";
/** Mutable callback view for input tests; production callers use the socket protocol. */
export type SocketServerInputTestHooks = Pick<SocketInput, keyof SocketInput> &
  Pick<SocketTextInput, keyof SocketTextInput> &
  Pick<
    SocketServerOperations,
    | "handleInputKey"
    | "handleInputTypeText"
    | "executeAndroidAppendText"
    | "executeInputTypeText"
    | "runImeActionWithinBudget"
    | "getAppendTextInput"
    | "resolveInputTargetDevice"
    | "requireCurrentFrameContext"
    | "runTrackedKeyedDeviceInput"
    | "evictDeviceInputCache"
    | "dispatchInputRoute"
    | "dispatchFencedInput"
  >;
