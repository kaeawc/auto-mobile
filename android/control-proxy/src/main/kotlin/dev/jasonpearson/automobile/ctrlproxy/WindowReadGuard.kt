package dev.jasonpearson.automobile.ctrlproxy

import android.os.SystemClock
import android.util.Log
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal const val WINDOW_READ_BUDGET_MS = 1_500L
internal const val WINDOW_READ_QUARANTINE_MS = 5_000L

internal sealed interface WindowReadResult<out T> {
  data class Completed<T>(val value: T) : WindowReadResult<T>

  data class Skipped(val reason: String) : WindowReadResult<Nothing>
}

/** [cleanup] runs once, after the read exits or immediately if it was never started. */
internal interface WindowReadGuard {
  fun <T> read(
    windowId: Int,
    read: () -> T,
    cleanup: () -> Unit = {},
    discard: (T) -> Unit = {},
  ): WindowReadResult<T>
}

/** A fake can expire a read without starting a thread or sleeping. */
internal interface WindowReadExecutor {
  fun <T> read(budgetMs: Long, read: () -> T, discard: (T) -> Unit): WindowReadResult<T>
}

/**
 * Binder accessibility waits ignore interrupts. Never queue behind an abandoned read, and never
 * retry a timed-out window while its abandoned worker is still stuck, even after the TTL.
 * Concurrent healthy reads remain independent; only a failure installs quarantine.
 */
internal class QuarantiningWindowReadGuard(
  private val executor: WindowReadExecutor = WorkerWindowReadExecutor(),
  private val nowMs: () -> Long = SystemClock::elapsedRealtime,
) : WindowReadGuard {
  private class Entry(var inFlight: Boolean = true, var retryAt: Long = 0)

  private val entries = mutableMapOf<Int, MutableList<Entry>>()

  override fun <T> read(
    windowId: Int,
    read: () -> T,
    cleanup: () -> Unit,
    discard: (T) -> Unit,
  ): WindowReadResult<T> {
    val entry =
      synchronized(entries) {
        val now = nowMs()
        entries.entries.removeAll {
          it.value.all { entry -> !entry.inFlight && entry.retryAt <= now }
        }
        if (entries.containsKey(windowId)) null else Entry()
      }
    if (entry == null) {
      cleanup()
      return WindowReadResult.Skipped("quarantined")
    }
    val result =
      try {
        executor.read(
          WINDOW_READ_BUDGET_MS,
          {
            try {
              read()
            } finally {
              cleanup()
              synchronized(entries) { entry.inFlight = false }
            }
          },
          discard,
        )
      } catch (error: kotlinx.coroutines.CancellationException) {
        Log.w("WindowReadGuard", "Accessibility window $windowId read cancelled", error)
        quarantine(windowId, entry)
        throw error
      }
    if (result is WindowReadResult.Skipped) quarantine(windowId, entry)
    if (result is WindowReadResult.Skipped && result.reason == "worker_unavailable") {
      cleanup()
      synchronized(entries) { entry.inFlight = false }
    }
    return result
  }

  private fun quarantine(windowId: Int, entry: Entry) {
    synchronized(entries) {
      entry.retryAt = nowMs() + WINDOW_READ_QUARANTINE_MS
      // Track every abandoned read if healthy concurrent requests overlapped before the timeout.
      entries.getOrPut(windowId) { mutableListOf() }.add(entry)
    }
  }
}

internal class WorkerWindowReadExecutor(private val executor: Executor = workers) :
  WindowReadExecutor {
  // The ExecutionException is logged; only a wrapped cancellation is rethrown, by its cause.
  @Suppress("SwallowedException")
  override fun <T> read(
    budgetMs: Long,
    read: () -> T,
    discard: (T) -> Unit,
  ): WindowReadResult<T> {
    val delivery = Delivery(discard)
    return try {
      CompletableFuture.supplyAsync({ read() }, executor).whenComplete { value, error ->
        if (error != null) {
          Log.w(TAG, "Accessibility window worker failed", error)
          val failure = if (error is CompletionException) error.cause ?: error else error
          delivery.future.completeExceptionally(failure)
        } else delivery.complete(value)
      }
      WindowReadResult.Completed(delivery.future.get(budgetMs, TimeUnit.MILLISECONDS))
    } catch (error: TimeoutException) {
      Log.w(TAG, "Accessibility window exceeded ${budgetMs}ms", error)
      delivery.abandon()
      WindowReadResult.Skipped("timeout")
    } catch (error: RejectedExecutionException) {
      Log.w(TAG, "Accessibility window worker unavailable", error)
      WindowReadResult.Skipped("worker_unavailable")
    } catch (error: InterruptedException) {
      Log.w(TAG, "Accessibility window wait interrupted", error)
      delivery.abandon()
      Thread.currentThread().interrupt()
      throw kotlinx.coroutines
        .CancellationException("Accessibility window wait interrupted")
        .apply {
          initCause(error)
        }
    } catch (error: ExecutionException) {
      Log.w(TAG, "Accessibility window read failed", error)
      val cause = error.cause
      if (cause is kotlinx.coroutines.CancellationException) throw cause
      WindowReadResult.Skipped("read_failed")
    }
  }

  /** Serializes timeout vs completion so late live-node results are recycled exactly once. */
  private class Delivery<T>(private val discard: (T) -> Unit) {
    val future = CompletableFuture<T>()
    private var abandoned = false
    private var completed: WindowReadResult.Completed<T>? = null

    @Synchronized
    fun complete(value: T) {
      if (abandoned) discard(value)
      else {
        completed = WindowReadResult.Completed(value)
        future.complete(value)
      }
    }

    @Synchronized
    fun abandon() {
      abandoned = true
      completed?.let { discard(it.value) }
      completed = null
    }
  }

  private companion object {
    const val TAG = "WindowReadGuard"
    // No fixed-size pool or queue: stuck Binder calls must not starve healthy windows. Quarantine
    // prevents repeat submissions for an abandoned window; idle daemon threads expire in 60s.
    val workers: ExecutorService = Executors.newCachedThreadPool { task ->
      Thread(task, "CtrlProxy-window-read").apply { isDaemon = true }
    }
  }
}
