package dev.jasonpearson.automobile.sdk.events

/** Strategy for handling events when the buffer is full. */
enum class BackPressureStrategy {
  /** Remove the oldest event to make room for the new one. */
  DROP_OLDEST,
  /** Reject the new event and keep existing buffer contents. */
  IGNORE_NEWEST,
}
