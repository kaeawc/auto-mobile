package dev.jasonpearson.automobile.ctrlproxy.ime

internal data class ImeReconciliationState(
  val postDispatch: Boolean,
  val startedByRestart: Boolean,
  val baseline: String?,
  val now: String?,
  val dispatched: List<String>,
  val lastResumeConfirmed: Int = -1,
)
