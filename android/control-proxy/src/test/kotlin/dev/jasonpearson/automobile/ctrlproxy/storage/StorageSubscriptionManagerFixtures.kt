package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import dev.jasonpearson.automobile.protocol.StorageChangeEvent
import dev.jasonpearson.automobile.protocol.StorageProtocolSerializer
import dev.jasonpearson.automobile.protocol.StorageResponse
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import java.util.concurrent.Executors
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before

internal open class StorageSubscriptionManagerFixtures {
  protected val workerDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()

  companion object {
    const val LATCH_CEILING_SECONDS = 30L
    const val JOIN_CEILING_MS = 30_000L
  }

  protected lateinit var context: Context
  protected lateinit var contentResolver: ContentResolver
  protected lateinit var manager: StorageSubscriptionManager
  protected val dispatcher = StandardTestDispatcher()
  protected val scope = TestScope(dispatcher)
  // Delays the manager asked for between a DISABLED reply and its retry; nothing really sleeps.
  protected val pauses = mutableListOf<Long>()

  @Before
  fun setUp() {
    contentResolver = mockk(relaxed = true)
    context = mockk(relaxed = true)
    every { context.contentResolver } returns contentResolver
    manager =
      StorageSubscriptionManager(
        context = context,
        ioDispatcher = dispatcher,
        scope = scope,
        config =
          StorageSubscriptionConfig(
            pause = { pauses += it },
          ),
      )
  }

  @After
  fun tearDown() {
    manager.destroy()
    scope.testScheduler.advanceUntilIdle()
    scope.cancel()
    workerDispatcher.close()
  }

  protected fun disabledReply() =
    Bundle().apply {
      putBoolean("success", false)
      putString("errorType", "DISABLED")
      putString("error", "SharedPreferences inspection is disabled")
    }

  /** Stubs the package manager so [packageName] is installed and stopped (or not). */
  protected fun givenInstalledPackage(packageName: String, stopped: Boolean) {
    val packageManager = mockk<PackageManager>(relaxed = true)
    val appInfo =
      ApplicationInfo().apply {
        this.packageName = packageName
        flags = if (stopped) ApplicationInfo.FLAG_STOPPED else 0
      }
    // Stub the exact legacy overload used by the stopped-package lookup on all API levels.
    @Suppress("DEPRECATION")
    every { packageManager.getApplicationInfo(eq(packageName), any<Int>()) } returns appInfo
    every { context.packageManager } returns packageManager
  }

  protected fun successReply() = Bundle().apply { putBoolean("success", true) }

  /** Stubs `subscribeToFile` to answer [replies] in order, repeating the last one. */
  protected fun givenSubscribeReplies(vararg replies: Bundle) {
    var next = 0
    every { contentResolver.call(any<Uri>(), eq("subscribeToFile"), any(), any()) } answers
      {
        replies[minOf(next++, replies.size - 1)]
      }
  }

  protected fun tokenSubscribeBundle(token: String?) =
    Bundle().apply {
      putBoolean("success", true)
      putString(
        "result",
        StorageProtocolSerializer.responseToJson(
          StorageResponse.SubscriptionResult("auth", subscribed = true, processToken = token),
        ),
      )
    }

  protected fun tokenChangesBundle(token: String?, sequences: List<Long>) =
    Bundle().apply {
      putBoolean("success", true)
      putString(
        "result",
        StorageProtocolSerializer.responseToJson(
          StorageResponse.Changes(
            "auth",
            sequences.map { sequence ->
              StorageChangeEvent(
                fileName = "auth",
                key = "key-$sequence",
                value = sequence.toString(),
                type = "LONG",
                timestamp = sequence,
                sequenceNumber = sequence,
              )
            },
            processToken = token,
          ),
        ),
      )
    }

  /** A fake app: replies to `getChanges` by applying the real SDK's `sequence > since` filter. */
  protected fun fakeAppProcess(
    token: String?,
    queued: List<Long>,
    requestedSince: MutableList<Long>,
  ) {
    every { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) } answers
      {
        val since = arg<Bundle>(3).getLong("sinceSequence", 0L)
        requestedSince.add(since)
        tokenChangesBundle(token, queued.filter { it > since })
      }
  }

  protected fun drainingAppProcess(
    token: String,
    queue: MutableList<Long>,
    requestedSince: MutableList<Long>,
    failRequestsWithSince: Long? = null,
  ) {
    every { contentResolver.call(any<Uri>(), eq("getChanges"), any(), any()) } answers
      {
        val since = arg<Bundle>(3).getLong("sinceSequence", 0L)
        requestedSince.add(since)
        if (since == failRequestsWithSince) {
          Bundle().apply {
            putBoolean("success", false)
            putString("error", "provider unavailable")
          }
        } else {
          val drained = queue.filter { it > since }
          queue.removeAll(drained.toSet())
          tokenChangesBundle(token, drained)
        }
      }
  }

  /**
   * A fake inspected app process. Like the real SDK it removes the changes it returns, restarts its
   * sequence counter with a new process token, and records a change only while its listener is
   * armed by `subscribeToFile` — a restart disarms it.
   */
  protected inner class FakeInspectedApp(var token: String) {
    var present = true
    var armed = false
    var failNextSubscribe = false
    val calls = mutableListOf<String>()
    private var counter = 0L
    private val queue = mutableListOf<Long>()

    fun restart(newToken: String) {
      token = newToken
      armed = false
      counter = 0
      queue.clear()
    }

    /** A preference write; lost to the inspector when the listener is not armed. */
    fun write(count: Int = 1) {
      if (!armed) return
      repeat(count) { queue.add(++counter) }
    }

    fun handle(method: String, since: Long): Bundle? {
      calls.add(method)
      if (!present) return null
      return when (method) {
        "subscribeToFile" ->
          if (failNextSubscribe) {
            failNextSubscribe = false
            Bundle().apply {
              putBoolean("success", false)
              putString("error", "provider unavailable")
            }
          } else {
            armed = true
            tokenSubscribeBundle(token)
          }
        "getChanges" -> {
          val drained = queue.filter { it > since }
          queue.removeAll(drained.toSet())
          tokenChangesBundle(token, drained)
        }
        else -> null
      }
    }

    fun count(method: String): Int = calls.count { it == method }
  }

  protected fun wireApp(app: FakeInspectedApp): ContentObserver {
    val observerSlot = slot<ContentObserver>()
    every { contentResolver.registerContentObserver(any(), any(), capture(observerSlot)) } returns
      Unit
    every { contentResolver.call(any<Uri>(), any<String>(), any(), any()) } answers
      {
        app.handle(arg<String>(1), arg<Bundle?>(3)?.getLong("sinceSequence", 0L) ?: 0L)
      }
    assertTrue(manager.subscribe("com.example.app", "auth").isSuccess)
    return observerSlot.captured
  }

  protected suspend fun nextSequences(count: Int): List<Long> =
    withTimeout(1_000) { manager.changeEvents.take(count).toList() }.map { it.sequenceNumber }

  protected fun changesBundle(fileName: String, sequences: List<Long>): Bundle =
    Bundle().apply {
      putBoolean("success", true)
      putString(
        "result",
        StorageProtocolSerializer.responseToJson(
          StorageResponse.Changes(
            fileName,
            sequences.map { sequence ->
              StorageChangeEvent(fileName, "key-$sequence", "$sequence", "LONG", sequence, sequence)
            },
          ),
        ),
      )
    }

  protected class RecordingProvider : ContentProvider() {
    val fetchLooper = CompletableDeferred<Looper?>()
    val unsubscribeLooper = CompletableDeferred<Looper?>()

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
      return when (method) {
        "getChanges" -> {
          fetchLooper.complete(Looper.myLooper())
          Bundle().apply {
            putBoolean("success", true)
            putString(
              "result",
              StorageProtocolSerializer.responseToJson(
                StorageResponse.Changes(
                  "auth",
                  listOf(StorageChangeEvent("auth", "key", "value", "STRING", 1L, 1L)),
                ),
              ),
            )
          }
        }
        "unsubscribeFromFile" -> {
          unsubscribeLooper.complete(Looper.myLooper())
          Bundle()
        }
        else -> Bundle().apply { putBoolean("success", true) }
      }
    }

    override fun onCreate() = true

    override fun query(
      uri: Uri,
      projection: Array<out String>?,
      selection: String?,
      selectionArgs: Array<out String>?,
      sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun update(
      uri: Uri,
      values: ContentValues?,
      selection: String?,
      selectionArgs: Array<out String>?,
    ) = 0
  }
}
