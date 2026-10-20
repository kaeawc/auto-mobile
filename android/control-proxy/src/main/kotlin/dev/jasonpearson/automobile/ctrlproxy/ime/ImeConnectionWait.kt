package dev.jasonpearson.automobile.ctrlproxy.ime

/** Readiness polling and commit budget captured once for a queued IME request. */
internal data class ImeConnectionWait(
  val driver: ImeCommitDriver,
  val deadlineMs: Long,
  val generation: Long,
  val commitBudgetMs: Long,
)
