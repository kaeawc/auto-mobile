package dev.jasonpearson.automobile.junit

/** Timing collaborators owned by one plan execution rather than shared mutable test hooks. */
internal data class PlanExecutorTimings(
  val retryBackoffMs: Long = 2000L,
  val deviceOwnedWaitBudgetMs: Long = 30_000L,
  val deviceOwnedSleeper: (Long) -> Unit = { Thread.sleep(it) },
)
