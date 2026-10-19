package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitResult
import dev.jasonpearson.automobile.ctrlproxy.ime.awaitImeServiceReady
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfiles
import dev.jasonpearson.automobile.ctrlproxy.ime.session.KeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import dev.jasonpearson.automobile.protocol.KeyboardProfileBehaviorInfo
import dev.jasonpearson.automobile.protocol.KeyboardProfileInfo
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.SetKeyboardProfileResult
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

/**
 * The CtrlProxy IME request surface: commitText (and its cancellation tombstones), keyboard profile
 * selection and the profile catalog, plus their result frames. Everything that needs the live
 * accessibility service, the CtrlProxyIme singleton or the late-bound WebSocket server comes
 * through [Host] and [ResponseSender].
 */
internal class ImeController(
  private val host: Host,
  private val timeProvider: TimeProvider,
  private val resultBroadcaster: ResultBroadcaster,
  private val jsonCompact: Json,
  private val responseSender: ResponseSender,
  private val uptimeMillis: () -> Long = android.os.SystemClock::uptimeMillis,
  private val pause: suspend (Long) -> Unit = { ms -> delay(ms) },
) {
  /** The live CtrlProxy keyboard, narrowed to what the commit path drives. */
  interface ImeTarget {
    fun commitText(
      text: String,
      priorImeId: String?,
      isCancelled: () -> Boolean,
      delivery: ImeTextDelivery,
      timeoutMs: Long?,
      requestDeadlineMs: Long,
      trace: Boolean,
      onResult: (ImeCommitResult) -> Unit,
    )
  }

  /** Service-side operations the controller cannot perform without the service or the IME. */
  interface Host {
    fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit)

    /** The running CtrlProxyIme, or null while the keyboard service has not been created. */
    fun currentIme(): ImeTarget?

    /** Switches the live keyboard profile; false when no keyboard instance is running. */
    fun setActiveProfile(id: String, onComplete: (Boolean) -> Unit): Boolean

    fun keyboardProfileStore(): KeyboardProfileStore

    /** Drops the remembered insert caret; a commit may move it. */
    fun forgetRememberedInsert()
  }

  /** Keeps the service's frame encoder and late-bound WebSocket server behind one seam. */
  interface ResponseSender {
    fun isRunning(): Boolean

    suspend fun broadcastWithPerfSync(
      type: String,
      requestId: String?,
      buildContent: JsonObjectBuilder.() -> Unit,
    )

    suspend fun broadcastSetKeyboardProfileResult(
      build: (perfTiming: String?) -> SetKeyboardProfileResult,
    )

    fun connectionCount(): Int
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  private class ImeCommitState {
    val cancelled = AtomicBoolean(false)
    val finished = CompletableDeferred<ImeCommitResult>()
  }

  // Cancelled IDs remain tombstoned until service shutdown. Request IDs are UUIDs; retaining a
  // cancellation prevents a delayed request from starting after its cancellation was acknowledged.
  private val imeCommitStates = java.util.concurrent.ConcurrentHashMap<String, ImeCommitState>()

  suspend fun requestCommitText(request: RequestCommitText) {
    val requestId = request.requestId
    val text = request.text
    val priorImeId = request.priorImeId
    val delivery = request.delivery
    val timeoutMs = request.timeoutMs
    val trace = request.trace

    host.forgetRememberedInsert()
    val start = timeProvider.currentTimeMillis()
    val requestDeadlineMs =
      timeoutMs?.let { uptimeMillis() + it.coerceAtLeast(0) } ?: Long.MAX_VALUE
    val state = requestId?.let { imeCommitStates.computeIfAbsent(it) { ImeCommitState() } }
    if (state?.cancelled?.get() == true) {
      host.launchRequestScope(requestId) {
        broadcastCommitTextResult(requestId, false, "IME commit cancelled", 0L, false)
      }
      return
    }
    host.launchRequestScope(requestId) {
      fun finish(result: ImeCommitResult) {
        state?.finished?.complete(result)
        if (state?.cancelled?.get() == false) imeCommitStates.remove(requestId, state)
      }
      // `ime set` can return before Android creates the InputMethodService. Give activation a
      // bounded window; the IME separately waits for its editor binding.
      val ime =
        awaitImeServiceReady(
          nowMs = uptimeMillis,
          delayMs = {
            pause(minOf(it, requestDeadlineMs - uptimeMillis()).coerceAtLeast(0))
          },
          probe = {
            host.currentIme()?.takeIf {
              uptimeMillis() < requestDeadlineMs
            }
          },
          isCancelled = {
            state?.cancelled?.get() == true || uptimeMillis() >= requestDeadlineMs
          },
        )
      if (state?.cancelled?.get() == true) {
        finish(ImeCommitResult(success = false, error = null))
        broadcastCommitTextResult(
          requestId,
          false,
          "IME commit cancelled",
          timeProvider.currentTimeMillis() - start,
          false,
        )
        return@launchRequestScope
      }
      if (ime == null) {
        finish(ImeCommitResult(success = false, error = null))
        broadcastCommitTextResult(
          requestId,
          false,
          "IME service did not start within timeout",
          timeProvider.currentTimeMillis() - start,
          false,
        )
        return@launchRequestScope
      }
      ime.commitText(
        text,
        priorImeId,
        { state?.cancelled?.get() == true },
        delivery,
        timeoutMs,
        requestDeadlineMs,
        trace,
      ) { result ->
        finish(result)
        host.launchRequestScope(requestId) {
          broadcastCommitTextResult(
            requestId,
            result.success,
            result.error,
            timeProvider.currentTimeMillis() - start,
            result.partialApplication,
            result.committedUnits,
            result.insertedText,
            if (trace) result.trace else null,
            editorConsumed = result.editorConsumed,
          )
        }
      }
    }
  }

  suspend fun requestCancelImeCommit(requestId: String?, targetRequestId: String) {
    val tombstone =
      ImeCommitState().apply {
        cancelled.set(true)
        finished.complete(ImeCommitResult(success = false, error = null))
      }
    val state = imeCommitStates.putIfAbsent(targetRequestId, tombstone) ?: tombstone
    state.cancelled.set(true)
    // An absent target is a tombstone: the original frame may still be queued on another socket.
    host.launchRequestScope(requestId) {
      val result = state.finished.await()
      resultBroadcaster.guard(requestId, "cancel_ime_commit_result") {
        responseSender.broadcastWithPerfSync("cancel_ime_commit_result", requestId) {
          put("success", true)
          put("targetRequestId", targetRequestId)
          put("partialApplication", result.partialApplication)
          if (result.committedUnits > 0) put("committedUnits", result.committedUnits)
        }
      }
    }
  }

  suspend fun requestSetKeyboardProfile(requestId: String?, profileId: String) {
    val profile = KeyboardProfiles.byId(profileId)
    if (profile == null) {
      val expected = KeyboardProfiles.all.joinToString(", ") { it.id }
      host.launchRequestScope(requestId) {
        broadcastSetKeyboardProfileResult(
          requestId,
          false,
          error = "Unknown keyboard profile '$profileId'; expected one of: $expected",
        )
      }
      return
    }

    val store = host.keyboardProfileStore()
    val previous = store.activeProfileId()
    val applied = CompletableDeferred<Boolean>()
    val live = host.setActiveProfile(profile.id) { applied.complete(it) }
    if (!live) {
      store.setActiveProfileId(profile.id)
      applied.complete(true)
    }
    host.launchRequestScope(requestId) {
      val success = applied.await()
      broadcastSetKeyboardProfileResult(
        requestId,
        success,
        if (success) profile.id else null,
        if (success) previous else null,
        if (success) null else "Failed to apply keyboard profile",
      )
    }
  }

  suspend fun requestListKeyboardProfiles(
    requestId: String?,
    supportedCatalogVersions: List<Int>,
  ) {
    val catalogVersion = KeyboardProfiles.negotiateCatalogVersion(supportedCatalogVersions)
    if (catalogVersion == null) {
      host.launchRequestScope(requestId) {
        broadcastKeyboardProfileCatalog(
          requestId = requestId,
          success = false,
          supportedCatalogVersions = KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS,
          error =
            "No mutually supported keyboard profile catalog version; device supports " +
              KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS.joinToString(", "),
        )
      }
      return
    }
    val profiles =
      KeyboardProfiles.all.map { profile ->
        KeyboardProfileInfo(
          id = profile.id,
          displayName = profile.displayName,
          version = profile.version,
          evidenceStatus = profile.evidenceStatus,
          evidenceNote = profile.evidenceNote,
          behavior =
            KeyboardProfileBehaviorInfo(
              composeWords = profile.behavior.composeWords,
              enterStrategy = profile.behavior.enterStrategy.name,
              backspaceStrategy = profile.behavior.backspaceStrategy.name,
              recomposeOnCursorMove = profile.behavior.recomposeOnCursorMove,
              recomposeOnBackspaceIntoWord = profile.behavior.recomposeOnBackspaceIntoWord,
              batchEdits = profile.behavior.batchEdits,
            ),
        )
      }
    val activeProfileId = host.keyboardProfileStore().activeProfileId()
    host.launchRequestScope(requestId) {
      broadcastKeyboardProfileCatalog(
        requestId = requestId,
        success = true,
        catalogVersion = catalogVersion,
        supportedCatalogVersions = KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS,
        activeProfileId = activeProfileId,
        profiles = profiles,
      )
    }
  }

  private suspend fun broadcastCommitTextResult(
    requestId: String?,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
    partialApplication: Boolean,
    committedUnits: Int = 0,
    insertedText: String? = null,
    trace: List<String>? = null,
    editorConsumed: Boolean = false,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping commit text result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "commit_text_result") {
      responseSender.broadcastWithPerfSync("commit_text_result", requestId) {
        put("success", success)
        put("totalTimeMs", totalTimeMs)
        if (partialApplication) put("partialApplication", true)
        if (committedUnits > 0) put("committedUnits", committedUnits)
        if (insertedText != null) put("insertedText", insertedText)
        if (editorConsumed) put("editorConsumed", true)
        if (trace != null) put("trace", Json.encodeToJsonElement(trace))
        if (error != null) {
          put("error", error)
        }
      }
      Log.d(
        TAG,
        "Broadcasted commit text result to ${responseSender.connectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastSetKeyboardProfileResult(
    requestId: String?,
    success: Boolean,
    activeProfileId: String? = null,
    previousProfileId: String? = null,
    error: String? = null,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping keyboard profile result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "set_keyboard_profile_result") {
      responseSender.broadcastSetKeyboardProfileResult { perfTiming ->
        SetKeyboardProfileResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = success,
          activeProfileId = activeProfileId,
          previousProfileId = previousProfileId,
          error = error,
          perfTiming = perfTiming,
        )
      }
      Log.d(
        TAG,
        "Broadcasted keyboard profile result to ${responseSender.connectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastKeyboardProfileCatalog(
    requestId: String?,
    success: Boolean,
    catalogVersion: Int? = null,
    supportedCatalogVersions: List<Int>,
    activeProfileId: String? = null,
    profiles: List<KeyboardProfileInfo> = emptyList(),
    error: String? = null,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping keyboard profile catalog response")
      return
    }

    resultBroadcaster.guard(requestId, "keyboard_profiles_result") {
      responseSender.broadcastWithPerfSync("keyboard_profiles_result", requestId) {
        put("success", success)
        put("catalogId", "automobile_behavior_profiles")
        if (catalogVersion != null) put("catalogVersion", catalogVersion)
        put("supportedCatalogVersions", jsonCompact.encodeToJsonElement(supportedCatalogVersions))
        if (activeProfileId != null) put("activeProfileId", activeProfileId)
        if (success) put("profiles", jsonCompact.encodeToJsonElement(profiles))
        if (error != null) put("error", error)
      }
    }
  }
}
