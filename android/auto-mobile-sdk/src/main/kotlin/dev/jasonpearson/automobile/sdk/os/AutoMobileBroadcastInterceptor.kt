package dev.jasonpearson.automobile.sdk.os

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import dev.jasonpearson.automobile.protocol.SdkBroadcastEvent
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer

/**
 * Intercepts a curated set of system broadcasts and records them as [SdkBroadcastEvent].
 *
 * Only captures broadcast action, categories, and extra key names + type names (not values) to
 * avoid leaking sensitive data.
 */
internal object AutoMobileBroadcastInterceptor {

  /** Curated system broadcasts to intercept (avoids noise). */
  // Package actions carry a `package:` data URI, so they must be matched by a
  // filter that declares addDataScheme("package"). The other actions carry no
  // data and must be matched by a scheme-less filter — a single filter with a
  // data scheme fails the data test for them (#3597).
  private val PACKAGE_ACTIONS = setOf(Intent.ACTION_PACKAGE_ADDED, Intent.ACTION_PACKAGE_REMOVED)

  private val MONITORED_ACTIONS =
    listOf(
      Intent.ACTION_LOCALE_CHANGED,
      Intent.ACTION_TIMEZONE_CHANGED,
      Intent.ACTION_SCREEN_ON,
      Intent.ACTION_SCREEN_OFF,
      Intent.ACTION_USER_PRESENT,
      Intent.ACTION_PACKAGE_ADDED,
      Intent.ACTION_PACKAGE_REMOVED,
    )

  @Volatile private var buffer: SdkEventBuffer? = null
  @Volatile private var applicationId: String? = null
  private var receiver: BroadcastReceiver? = null

  internal fun initialize(context: Context, buffer: SdkEventBuffer) {
    this.buffer = buffer
    this.applicationId = context.packageName

    val broadcastReceiver =
      object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
          if (intent == null) return
          val action = intent.action ?: return

          val categories = intent.categories?.toList()
          val extraKeys =
            intent.extras?.keySet()?.associateWith { key ->
              intent.extras?.get(key)?.javaClass?.simpleName ?: "null"
            }

          buffer.add(
            SdkBroadcastEvent(
              timestamp = System.currentTimeMillis(),
              applicationId = applicationId,
              action = action,
              categories = categories,
              extraKeys = extraKeys,
            )
          )
        }
      }

    receiver = broadcastReceiver

    buildFilters().forEach { filter -> registerReceiver(context, broadcastReceiver, filter) }
  }

  /**
   * Build the intent filters the interceptor registers. Two are needed: a scheme-less filter for
   * the plain system actions and a `package`-scheme filter for the package add/remove actions,
   * because a single filter declaring a data scheme fails the data test for scheme-less broadcasts
   * (#3597).
   */
  internal fun buildFilters(): List<IntentFilter> {
    val plainFilter =
      IntentFilter().apply {
        MONITORED_ACTIONS.filterNot { it in PACKAGE_ACTIONS }.forEach { addAction(it) }
      }
    val packageFilter =
      IntentFilter().apply {
        PACKAGE_ACTIONS.forEach { addAction(it) }
        addDataScheme("package")
      }
    return listOf(plainFilter, packageFilter)
  }

  private fun registerReceiver(
    context: Context,
    receiver: BroadcastReceiver,
    filter: IntentFilter,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag") context.registerReceiver(receiver, filter)
    }
  }

  fun shutdown(context: Context) {
    receiver?.let {
      try {
        context.unregisterReceiver(it)
      } catch (_: Exception) {}
    }
    receiver = null
    buffer = null
    applicationId = null
  }
}
