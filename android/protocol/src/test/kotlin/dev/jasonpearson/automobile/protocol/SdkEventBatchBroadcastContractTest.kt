package dev.jasonpearson.automobile.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class SdkEventBatchBroadcastContractTest {
  @Test
  fun `result codes are stable distinct and exclude unacknowledged defaults`() {
    val codes =
      listOf(
        SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED,
        SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_QUEUE_FULL,
        SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD,
      )

    assertEquals(listOf(1000, 1001, 1002), codes)
    assertEquals(codes.size, codes.toSet().size)
    assertFalse(0 in codes)
    assertFalse(-1 in codes)
  }

  @Test
  fun `batch id extra key is stable`() {
    assertEquals(
      "dev.jasonpearson.automobile.sdk.EVENT_BATCH_ID",
      SdkEventBatchBroadcastContract.EXTRA_BATCH_ID,
    )
  }

  @Test
  fun `ack capability metadata key is stable`() {
    assertEquals(
      "dev.jasonpearson.automobile.ctrlproxy.SDK_EVENT_BATCH_ACK_SUPPORTED",
      SdkEventBatchBroadcastContract.META_DATA_ACK_SUPPORTED,
    )
  }
}
