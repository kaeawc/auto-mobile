package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.models.FrameMetricsSnapshot
import dev.jasonpearson.automobile.ctrlproxy.models.RecompositionSnapshot
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.FrameMetricsData
import dev.jasonpearson.automobile.protocol.FrameMetricsEventResponse
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer

private const val TAG = "CtrlProxy"

/** Receives the legacy and protocol navigation-event broadcasts and queues them for batching. */
internal class NavigationEventReceiver(
  private val sdkEventBatchProcessor: () -> SdkEventBatchProcessor,
  private val timeProvider: TimeProvider,
) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null || intent.action != AutoMobileSDK.ACTION_NAVIGATION_EVENT) {
      return
    }

    try {
      // Try type-safe deserialization first (new protocol)
      val eventJson = intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)
      if (eventJson != null) {
        val event = SdkEventSerializer.navigationEventFromJson(eventJson)
        if (event != null) {
          Log.d(
            TAG,
            "Received navigation event (protocol): ${event.destination} from ${event.source} (app: ${event.applicationId})",
          )
          if (
            !sdkEventBatchProcessor()
              .enqueueNavigationEvent(
                NavigationEventInput(
                  destination = event.destination,
                  source = event.source.name,
                  arguments = event.arguments ?: emptyMap(),
                  metadata = event.metadata ?: emptyMap(),
                  applicationId = event.applicationId,
                  timestamp = event.timestamp,
                ),
              )
          ) {
            Log.w(TAG, "Dropping navigation event because the SDK event queue is full")
          }
          return
        }
      }

      receiveLegacy(intent)
    } catch (e: Exception) {
      Log.e(TAG, "Error handling navigation event broadcast", e)
    }
  }

  private fun receiveLegacy(intent: Intent) {
    // Fallback to legacy extras for backward compatibility
    val destination = intent.getStringExtra(AutoMobileSDK.EXTRA_DESTINATION) ?: return
    val source = intent.getStringExtra(AutoMobileSDK.EXTRA_SOURCE) ?: return
    val applicationId = intent.getStringExtra(AutoMobileSDK.EXTRA_APPLICATION_ID)

    val (arguments, metadata) = navigationExtras(intent)

    Log.d(
      TAG,
      "Received navigation event (legacy): $destination from $source (app: $applicationId)",
    )
    if (
      !sdkEventBatchProcessor()
        .enqueueNavigationEvent(
          NavigationEventInput(
            destination = destination,
            source = source,
            arguments = arguments,
            metadata = metadata,
            applicationId = applicationId,
            timestamp = timeProvider.currentTimeMillis(),
          ),
        )
    ) {
      Log.w(TAG, "Dropping navigation event because the SDK event queue is full")
    }
  }
}

/** Receives Compose recomposition snapshots from the SDK and stores the latest one. */
internal class RecompositionSnapshotReceiver(
  private val jsonLenient: Json,
  private val recompositionStore: RecompositionStore,
) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null || intent.action != AutoMobileSDK.ACTION_RECOMPOSITION_SNAPSHOT) {
      return
    }

    val payload = intent.getStringExtra(AutoMobileSDK.EXTRA_RECOMPOSITION_SNAPSHOT) ?: return
    val snapshot =
      try {
        jsonLenient.decodeFromString(serializer<RecompositionSnapshot>(), payload)
      } catch (e: IllegalArgumentException) {
        Log.e(TAG, "Failed to parse recomposition snapshot", e)
        return
      }
    recompositionStore.updateSnapshot(snapshot)
  }
}

/** Receives frame-metrics snapshots, stores them and forwards them live while the server runs. */
internal class FrameMetricsSnapshotReceiver(
  private val jsonLenient: Json,
  private val frameMetricsStore: FrameMetricsStore,
  private val scope: CoroutineScope,
  private val isRunning: () -> Boolean,
  private val broadcast: suspend (WebSocketResponse) -> Unit,
) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null || intent.action != AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT) {
      return
    }

    val payload = intent.getStringExtra(AutoMobileSDK.EXTRA_FRAME_METRICS_SNAPSHOT) ?: return
    val snapshot =
      try {
        jsonLenient.decodeFromString(serializer<FrameMetricsSnapshot>(), payload)
      } catch (e: IllegalArgumentException) {
        Log.e(TAG, "Failed to parse frame metrics snapshot", e)
        return
      }
    frameMetricsStore.updateSnapshot(snapshot)
    // Forward live so the host can feed real app-frame data into perfSnapshot.
    if (isRunning()) {
      val response =
        FrameMetricsEventResponse(
          timestamp = snapshot.timestamp,
          frameMetrics =
            FrameMetricsData(
              applicationId = snapshot.applicationId,
              fps = snapshot.fps,
              frameTimeMs = snapshot.frameTimeMs,
              jankFrames = snapshot.jankFrames,
              totalFrames = snapshot.totalFrames,
            ),
        )
      scope.launch { broadcast(response) }
    }
  }
}

private fun navigationExtras(intent: Intent): Pair<Map<String, String>, Map<String, String>> {
  // Extract arguments (prefixed with "arg_")
  val arguments = mutableMapOf<String, String>()
  val metadata = mutableMapOf<String, String>()

  intent.extras?.keySet()?.forEach { key ->
    when {
      key.startsWith("arg_") -> {
        intent.getStringExtra(key)?.let { value ->
          arguments[key.removePrefix("arg_")] = value
        }
      }
      key.startsWith("meta_") -> {
        intent.getStringExtra(key)?.let { value ->
          metadata[key.removePrefix("meta_")] = value
        }
      }
    }
  }

  return arguments to metadata
}
