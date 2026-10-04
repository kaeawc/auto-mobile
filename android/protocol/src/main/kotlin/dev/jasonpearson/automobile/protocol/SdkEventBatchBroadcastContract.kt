package dev.jasonpearson.automobile.protocol

/**
 * Result-code contract for [SdkEventSerializer.ACTION_SDK_EVENT_BATCH].
 *
 * Only ordered broadcasts receive a result. Non-ordered broadcasts have no acknowledgement and
 * receivers must not set their result code. The sender must initialize an ordered broadcast with a
 * default code (0 or -1), both of which mean "not acknowledged": a broadcast with no receiver, or a
 * receiver without acknowledgement support, leaves that default unchanged. Only
 * [RESULT_BATCH_ACCEPTED] means accepted; rejection codes and all other codes mean undelivered.
 * Acceptance is a synchronous queue handoff, not durable storage or downstream WebSocket delivery.
 */
object SdkEventBatchBroadcastContract {
  /** The processor synchronously accepted the parsed batch into its bounded queue. */
  const val RESULT_BATCH_ACCEPTED = 1000

  /** The processor synchronously rejected the parsed batch because its queue is full. */
  const val RESULT_BATCH_REJECTED_QUEUE_FULL = 1001

  /** The JSON extra is missing, cannot be parsed, or does not contain an [SdkEventBatch]. */
  const val RESULT_BATCH_REJECTED_INVALID_PAYLOAD = 1002

  /**
   * CtrlProxy application manifest metadata boolean advertising this acknowledgement contract.
   *
   * The SDK sender (PR B) should query its CtrlProxy package via
   * `PackageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)` and require
   * `applicationInfo.metaData?.getBoolean(META_DATA_ACK_SUPPORTED, false) == true` before enabling
   * acknowledged delivery. Missing/false metadata means an older, un-acking CtrlProxy. This marker
   * is independent of release versions and does not imply the accessibility service is running. SDK
   * hosts on API 30+ may need package visibility (e.g. a `<queries>` entry for CtrlProxy) to
   * resolve the package; that visibility requirement belongs to the sender integration in PR B.
   */
  const val META_DATA_ACK_SUPPORTED =
    "dev.jasonpearson.automobile.ctrlproxy.SDK_EVENT_BATCH_ACK_SUPPORTED"
}
