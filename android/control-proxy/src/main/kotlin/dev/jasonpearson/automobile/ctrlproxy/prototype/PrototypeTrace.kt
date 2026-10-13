package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Build
import android.os.Trace
import java.util.concurrent.atomic.AtomicInteger

internal interface PrototypeTraceSink {
  fun isEnabled(): Boolean

  fun begin(name: String)

  fun end()

  fun beginAsync(name: String, cookie: Int)

  fun endAsync(name: String, cookie: Int)
}

/**
 * Sections are emitted only while tracing is enabled, which the framework can report from API 29.
 * Below API 29 (and in plain JVM unit tests), no section is emitted and no [Trace] method is
 * called.
 */
internal object PrototypeTrace {
  const val VALIDATE_STATE_WRITE = "Prototype.validateStateWrite"
  const val PREPARE_STATE_WRITES = "Prototype.prepareStateWrites"
  const val MAP_RENDER_TREE = "Prototype.mapRenderTree"
  const val MAP_PROTOTYPE_SPEC = "Prototype.mapPrototypeSpec"
  const val COMPOSE = "Prototype.compose"
  const val NODE = "Prototype.node"
  const val INTERACT = "Prototype.interact"
  const val SYNC_APPEARANCE = "Prototype.syncAppearance"
  const val HOST_SHOW = "Prototype.host.show"

  private val asyncCookie = AtomicInteger()

  @Volatile var sink: PrototypeTraceSink = FrameworkPrototypeTraceSink

  inline fun <T> section(name: String, block: () -> T): T {
    val traceSink = sink
    if (!traceSink.isEnabled()) return block()
    traceSink.begin(name)
    try {
      return block()
    } finally {
      traceSink.end()
    }
  }

  suspend inline fun <T> asyncSection(name: String, block: () -> T): T {
    val traceSink = sink
    if (!traceSink.isEnabled()) return block()
    val cookie = asyncCookie.getAndIncrement()
    traceSink.beginAsync(name, cookie)
    try {
      return block()
    } finally {
      traceSink.endAsync(name, cookie)
    }
  }
}

private object FrameworkPrototypeTraceSink : PrototypeTraceSink {
  override fun isEnabled(): Boolean = Build.VERSION.SDK_INT >= 29 && Trace.isEnabled()

  override fun begin(name: String) = Trace.beginSection(name)

  override fun end() = Trace.endSection()

  override fun beginAsync(name: String, cookie: Int) {
    if (Build.VERSION.SDK_INT >= 29) Trace.beginAsyncSection(name, cookie)
  }

  override fun endAsync(name: String, cookie: Int) {
    if (Build.VERSION.SDK_INT >= 29) Trace.endAsyncSection(name, cookie)
  }
}
