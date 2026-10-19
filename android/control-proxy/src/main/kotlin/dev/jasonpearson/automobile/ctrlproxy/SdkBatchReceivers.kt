package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr

private const val TAG = "CtrlProxy"

/** Receives SDK event-batch broadcasts and acknowledges them through the batch handler. */
internal class EventBatchReceiver(private val handler: SdkEventBatchBroadcastHandler) :
  BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null || intent.action != SdkEventSerializer.ACTION_SDK_EVENT_BATCH) {
      return
    }

    try {
      val ordered = isOrderedBroadcast
      val setBroadcastResult = this::setResultCode
      handler.handle(
        intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON),
        object : SdkEventBatchBroadcastHandler.ResultSink {
          override val isOrdered = ordered

          override fun setResultCode(code: Int) {
            setBroadcastResult(code)
          }
        },
        batchId = intent.getStringExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID),
      )
    } catch (e: Exception) {
      Log.e(TAG, "Error handling event batch broadcast", e)
    }
  }
}

/** Receives SDK ANR broadcasts and acknowledges them through the ANR handler. */
internal class AnrReceiver(private val handler: SdkAnrBroadcastHandler) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null || intent.action != AutoMobileAnr.ACTION_ANR) return
    try {
      val ordered = isOrderedBroadcast
      val setBroadcastResult = this::setResultCode
      handler.handle(
        intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON),
        object : SdkEventBatchBroadcastHandler.ResultSink {
          override val isOrdered = ordered

          override fun setResultCode(code: Int) {
            setBroadcastResult(code)
          }
        },
        deliveryId = intent.getStringExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID),
      )
    } catch (e: Exception) {
      Log.e(TAG, "Error handling ANR broadcast", e)
    }
  }
}
