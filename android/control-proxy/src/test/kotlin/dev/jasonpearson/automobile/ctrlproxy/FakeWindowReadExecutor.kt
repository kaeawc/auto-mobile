package dev.jasonpearson.automobile.ctrlproxy

/** Virtual durations only: no sleeps, real workers, or wall-clock timing assertions. */
internal class FakeWindowReadExecutor : WindowReadExecutor {
  var nowMs = 0L
  var reading = false
    private set

  val durations = ArrayDeque<Long>()
  val budgets = mutableListOf<Long>()
  val abandonedReads = ArrayDeque<() -> Unit>()

  override fun <T> read(
    budgetMs: Long,
    read: () -> T,
    discard: (T) -> Unit,
  ): WindowReadResult<T> {
    budgets += budgetMs
    val duration = durations.removeFirstOrNull() ?: 0L
    if (duration > budgetMs) {
      nowMs += budgetMs
      // Retain the callback to model an uninterruptible read that may return much later.
      abandonedReads.addLast { discard(read()) }
      return WindowReadResult.Skipped("timeout")
    }
    nowMs += duration
    reading = true
    return try {
      WindowReadResult.Completed(read())
    } finally {
      reading = false
    }
  }
}
