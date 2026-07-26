package dev.jasonpearson.automobile.desktop.core.control

import java.util.concurrent.atomic.AtomicLong

/**
 * Orders overlapping device-control tap attempts so only the latest one may publish (or leave
 * cleared) the shared error banner (issue #3347).
 *
 * Taps are asynchronous: a click snapshots its target and launches an IO coroutine. Two clicks in
 * quick succession race — the newer tap clears the banner before launching, and without ordering a
 * late failure from the older tap would resurrect its stale error over the newer attempt. Each tap
 * claims a monotonically increasing token at click time via [nextToken] (on the UI thread) and,
 * when it completes on the IO dispatcher, publishes its error only while [isCurrent] still holds.
 *
 * Backed by an [AtomicLong] so the UI-thread claim and the IO-thread check are safe without extra
 * synchronization.
 */
class ControlTapErrorGate {
  private val latest = AtomicLong(0L)

  /** Claim the newest attempt slot and return this attempt's token. Call once per click. */
  fun nextToken(): Long = latest.incrementAndGet()

  /** True while [token] is still the most recently claimed attempt (nothing newer has started). */
  fun isCurrent(token: Long): Boolean = token == latest.get()
}
