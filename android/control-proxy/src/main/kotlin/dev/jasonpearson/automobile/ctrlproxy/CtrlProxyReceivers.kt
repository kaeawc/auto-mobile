package dev.jasonpearson.automobile.ctrlproxy

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.Json

private const val TAG = "CtrlProxy"

/**
 * Owns the service's broadcast receivers and registers and releases them as one set. Each receiver
 * reaches the service only through [Host].
 */
internal class CtrlProxyReceivers(
  private val context: Context,
  scope: CoroutineScope,
  timeProvider: TimeProvider,
  recompositionStore: RecompositionStore,
  host: Host,
) {
  /** The service members the receivers need, beyond the per-receiver host contracts. */
  interface Host : CommandHost, PackageEventHost, FailureReportHost, ScreenStateHost {
    /** Read on each event: the processor is built lazily on the service scope. */
    fun sdkEventBatchProcessor(): SdkEventBatchProcessor

    fun isServerRunning(): Boolean

    suspend fun broadcast(response: WebSocketResponse)
  }

  private val jsonLenient = Json { ignoreUnknownKeys = true }

  private val log =
    object : SdkEventBatchBroadcastHandler.LogSink {
      override fun debug(message: String) {
        Log.d(TAG, message)
      }

      override fun warn(message: String) {
        Log.w(TAG, message)
      }
    }

  private val commandReceiver = CommandReceiver(scope, host)

  private val navigationEventReceiver =
    NavigationEventReceiver(
      sdkEventBatchProcessor = host::sdkEventBatchProcessor,
      timeProvider = timeProvider,
    )

  private val recompositionReceiver =
    RecompositionSnapshotReceiver(
      jsonLenient = jsonLenient,
      recompositionStore = recompositionStore,
    )

  private val frameMetricsReceiver =
    FrameMetricsSnapshotReceiver(
      jsonLenient = jsonLenient,
      frameMetricsStore = FrameMetricsStore(),
      scope = scope,
      isRunning = host::isServerRunning,
      broadcast = host::broadcast,
    )

  private val packageReceiver = PackageEventReceiver(scope, host)

  private val handledExceptionReceiver = HandledExceptionReceiver(scope, host)

  private val crashReceiver = CrashReceiver(scope, host)

  private val screenStateReceiver = ScreenStateReceiver(host)

  private val anrBroadcastHandler =
    SdkAnrBroadcastHandler(
      enqueue = { event ->
        host
          .sdkEventBatchProcessor()
          .enqueue(SdkEventBatch(timestamp = event.timestamp, events = listOf(event)))
      },
      log = log,
    )

  private val anrReceiver = AnrReceiver(anrBroadcastHandler)

  private val eventBatchBroadcastHandler =
    SdkEventBatchBroadcastHandler(
      enqueue = { batch -> host.sdkEventBatchProcessor().enqueue(batch) },
      log = log,
    )

  private val eventBatchReceiver = EventBatchReceiver(eventBatchBroadcastHandler)

  /**
   * The receivers for broadcasts from other processes, in registration order: commands first, then
   * the SDK event receivers, before the slower service initialization. The SDK sender cannot detect
   * an absent dynamic receiver, while SdkEventBatchProcessor retains accepted events until the
   * WebSocket starts. Registration and teardown both read this list, so each one is released.
   */
  private fun exportedReceivers(): List<Triple<String, BroadcastReceiver, () -> IntentFilter>> =
    listOf(
      Triple("command", commandReceiver, ReceiverFilters::command),
      Triple("navigation event", navigationEventReceiver, ReceiverFilters::navigation),
      Triple("event batch", eventBatchReceiver, ReceiverFilters::eventBatch),
      Triple("recomposition", recompositionReceiver, ReceiverFilters::recomposition),
      Triple("frame metrics", frameMetricsReceiver, ReceiverFilters::frameMetrics),
      Triple("package", packageReceiver, ReceiverFilters::packages),
      Triple("handled exception", handledExceptionReceiver, ReceiverFilters::handledException),
      Triple("crash", crashReceiver, ReceiverFilters::crash),
      Triple("ANR", anrReceiver, ReceiverFilters::anr),
    )

  /** Registers every broadcast receiver; [unregister] releases the same set. */
  fun register() {
    for ((name, receiver, filter) in exportedReceivers()) {
      registerExported(receiver, filter())
      Log.d(TAG, "${name.replaceFirstChar(Char::uppercaseChar)} receiver registered")
    }

    // Screen on/off and unlock are protected system broadcasts, so this one is not exported. The
    // filter stays inline so lint can see that and accept the flagless registration.
    val screenStateFilter =
      IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_SCREEN_OFF)
        addAction(Intent.ACTION_USER_PRESENT)
      }
    context.registerReceiver(screenStateReceiver, screenStateFilter)
    Log.d(TAG, "Screen state receiver registered")
  }

  /** Releases every receiver [register] registered, continuing past a failed one. */
  fun unregister() {
    releaseEach(
      exportedReceivers().map { (name, receiver) -> name to receiver } +
        ("screen state" to screenStateReceiver),
      release = { context.unregisterReceiver(it) },
      onFailure = { name, e -> Log.e(TAG, "Error unregistering $name receiver", e) },
    )
  }

  /**
   * Registers a receiver for broadcasts sent from other processes (the SDK in an app under test,
   * the daemon's ADB broadcasts, the package manager), exported as Android 13+ requires.
   */
  fun registerExported(receiver: BroadcastReceiver, filter: IntentFilter) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      @SuppressLint("UnspecifiedRegisterReceiverFlag") context.registerReceiver(receiver, filter)
    }
  }
}
