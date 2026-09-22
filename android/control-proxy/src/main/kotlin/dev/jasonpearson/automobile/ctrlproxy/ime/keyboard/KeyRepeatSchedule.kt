package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard

class KeyRepeatSchedule(val initialDelayMs: Long = 400, val intervalMs: Long = 50) {
  init {
    require(initialDelayMs > 0 && intervalMs > 0)
  }

  fun firesAt(elapsedMs: Long): Int =
    if (elapsedMs < initialDelayMs) 1
    else
      (elapsedMs - initialDelayMs)
        .div(intervalMs)
        .coerceAtMost(Int.MAX_VALUE.toLong() - 2)
        .toInt() + 2
}
