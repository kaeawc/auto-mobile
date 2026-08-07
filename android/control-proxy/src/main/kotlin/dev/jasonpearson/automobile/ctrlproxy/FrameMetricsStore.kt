package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.FrameMetricsSnapshot
import java.util.concurrent.atomic.AtomicReference

/**
 * Holds the latest frame-metrics snapshot broadcast by the in-app SDK. Frame metrics are forwarded
 * live over the WebSocket (unlike recomposition, which rides the hierarchy), so this store exists
 * mainly to make the receiver's decode step unit-testable and to expose the most recent value to
 * any consumer.
 */
class FrameMetricsStore {
  private val latest = AtomicReference<FrameMetricsSnapshot?>(null)

  fun updateSnapshot(snapshot: FrameMetricsSnapshot) {
    latest.set(snapshot)
  }

  fun getLatest(): FrameMetricsSnapshot? = latest.get()
}
