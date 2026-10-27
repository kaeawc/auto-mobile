import type { SocketLifecycle } from "./SocketLifecycle";
import type { SocketTransport } from "./SocketTransport";
import type { SocketAdmission } from "./SocketAdmission";
import type { McpExecution } from "./McpExecution";
import type { McpRouting } from "./McpRouting";
import type { McpBindings } from "./McpBindings";
import type { SocketIdeRoutes } from "./SocketIdeRoutes";
import type { SocketInput } from "./SocketInput";
import type { SocketTextInput } from "./SocketTextInput";
export type SocketServerOperations = Pick<SocketLifecycle, keyof SocketLifecycle> &
  Pick<SocketTransport, keyof SocketTransport> &
  Pick<SocketAdmission, keyof SocketAdmission> &
  Pick<McpExecution, keyof McpExecution> &
  Pick<McpRouting, keyof McpRouting> &
  Pick<McpBindings, keyof McpBindings> &
  Pick<SocketIdeRoutes, keyof SocketIdeRoutes> &
  Pick<SocketInput, keyof SocketInput> &
  Pick<SocketTextInput, keyof SocketTextInput>;
export type SocketServerOverrides = Pick<
  SocketServerOperations,
  | "start"
  | "startDetached"
  | "stopAcceptingAndFanOut"
  | "handleConnection"
  | "releaseSocketSession"
  | "abortMcpRequests"
  | "mcpRequestSignal"
  | "broadcastResourceUpdated"
  | "pushProgressNotification"
  | "writeFrameData"
  | "handleRequest"
  | "mcpForwardFailureResponse"
  | "requireRemainingMcpForwardBudget"
  | "runKeyedMcpForward"
  | "getMcpForwardRoute"
  | "restoreSelectorSessions"
  | "recordBoundMcpClientKey"
  | "clearBoundMcpClientKey"
  | "forwardMcpRequest"
  | "remainingMcpForwardBudget"
  | "getRequestArgumentScopeKey"
  | "handleLocalSocketRequest"
  | "handleIdeSocketRequest"
  | "listBootedDevicesForIdeAction"
  | "runIdeKeyValueMutation"
  | "toIosRunnerCoordinates"
  | "handleInputTap"
  | "handleInputSwipe"
  | "handleInputGesture"
  | "captureStrokeAdmission"
  | "strokeAdmissionStillHolds"
  | "liftSessionlessStrokesOn"
  | "liftStrokesHeldByOn"
  | "liftStrokesHeldBy"
  | "handleInputTypeText"
  | "handleInputPressButton"
  | "handleInputKey"
  | "requireCurrentFrameContext"
  | "resolveInputTargetDevice"
  | "captureInputTargetOwner"
  | "runTrackedKeyedDeviceInput"
  | "dispatchFencedInput"
  | "runTrackedDeviceInput"
  | "answeringSessionRelease"
  | "handleIdeRequest"
  | "withSocketSessionAutolockKey"
  | "scheduleForwardKeyIdle"
  | "clearForwardKeyIdleTimer"
  | "evictDeviceInputCache"
  | "isListening"
  | "getClientConnectionCount"
  | "getAcceptedClientConnectionCount"
  | "quiesce"
  | "drainSessionReleaseNotifications"
  | "close"
>;
