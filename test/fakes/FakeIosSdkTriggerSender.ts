import type { IosSdkTriggerSender } from "../../src/features/action/IosSdkTrigger";
import type { SdkTriggerRequest } from "../../src/features/observe/ios/CtrlProxySdkTrigger";
import type { CtrlProxySdkTriggerResult } from "../../src/features/observe/ios/types";

/** Records SDK trigger requests and replays a scripted runner result. */
export class FakeIosSdkTriggerSender implements IosSdkTriggerSender {
  readonly requests: SdkTriggerRequest[] = [];
  result: CtrlProxySdkTriggerResult = {
    success: true,
    available: true,
    statusCode: 200,
    totalTimeMs: 0,
  };
  error: Error | null = null;

  async requestSdkTrigger(request: SdkTriggerRequest): Promise<CtrlProxySdkTriggerResult> {
    this.requests.push(request);
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}
