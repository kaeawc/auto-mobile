package dev.jasonpearson.automobile.discover.ictrace

data class IcTraceEvent(
  val seq: Int,
  val elapsedMs: Long,
  val call: String,
  val args: String,
  val selectionStart: Int,
  val selectionEnd: Int,
  val composingStart: Int,
  val composingEnd: Int,
)
