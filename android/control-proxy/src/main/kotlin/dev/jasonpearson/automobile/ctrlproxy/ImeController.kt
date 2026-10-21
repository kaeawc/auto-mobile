package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitRequest
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeCommitResult
import dev.jasonpearson.automobile.ctrlproxy.ime.awaitImeServiceReady
import dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile.KeyboardProfiles
import dev.jasonpearson.automobile.ctrlproxy.ime.session.KeyboardProfileStore
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.KeyboardProfileBehaviorInfo
import dev.jasonpearson.automobile.protocol.KeyboardProfileInfo
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.SetKeyboardProfileResult
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json

/** Monotonic deadlines and suspending waits used while the IME becomes ready. */
internal data class ImeConfig(
  val uptimeMillis: () -> Long = android.os.SystemClock::uptimeMillis,
  val pause: suspend (Long) -> Unit = { ms -> delay(ms) },
)

/**
 * The CtrlProxy IME request surface: commitText (and its cancellation tombstones), keyboard profile
 * selection and the profile catalog, plus their result frames. Everything that needs the live
 * accessibility service, the CtrlProxyIme singleton or the late-bound WebSocket server comes
 * through [Host] and [ResultSender].
 */
internal class ImeController(
  private val host: Host,
  private val timeProvider: TimeProvider,
  private val jsonCompact: Json,
  private val resultSender: ResultSender,
  config: ImeConfig = ImeConfig(),
) {
  private val uptimeMillis = config.uptimeMillis
  private val pause = config.pause

  /** The live CtrlProxy keyboard, narrowed to what the commit path drives. */
  interface ImeTarget {
    fun commitText(request: ImeCommitRequest, onResult: (ImeCommitResult) -> Unit)
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
        broadcastFailedCommit(requestId, "IME commit cancelled", 0L)
      }
      return
    }
    host.launchRequestScope(requestId) {
      fun finish(result: ImeCommitResult) {
        state?.finished?.complete(result)
        if (state?.cancelled?.get() == false) imeCommitStates.remove(requestId, state)
      }
      val ime = awaitCommitService(state, requestDeadlineMs)
      if (state?.cancelled?.get() == true) {
        finish(ImeCommitResult(success = false, error = null))
        broadcastFailedCommit(
          requestId,
          "IME commit cancelled",
          timeProvider.currentTimeMillis() - start,
        )
        return@launchRequestScope
      }
      if (ime == null) {
        finish(ImeCommitResult(success = false, error = null))
        broadcastFailedCommit(
          requestId,
          "IME service did not start within timeout",
          timeProvider.currentTimeMillis() - start,
        )
        return@launchRequestScope
      }
      ime.commitText(
        ImeCommitRequest(
          text = text,
          priorImeId = priorImeId,
          isCancelled = { state?.cancelled?.get() == true },
          delivery = delivery,
          timeoutMs = timeoutMs,
          requestDeadlineMs = requestDeadlineMs,
          trace = trace,
        ),
      ) { result ->
        finish(result)
        host.launchRequestScope(requestId) {
          broadcastCommitTextResult(
            commitResultFrame(requestId, result, timeProvider.currentTimeMillis() - start, trace),
          )
        }
      }
    }
  }

  private suspend fun broadcastFailedCommit(requestId: String?, error: String, totalTimeMs: Long) {
    broadcastCommitTextResult(failedCommitFrame(requestId, error, totalTimeMs))
  }

  private suspend fun awaitCommitService(state: ImeCommitState?, requestDeadlineMs: Long) =
    // `ime set` may complete before the service binds its editor.
    awaitImeServiceReady(
      nowMs = uptimeMillis,
      delayMs = { pause(minOf(it, requestDeadlineMs - uptimeMillis()).coerceAtLeast(0)) },
      probe = { host.currentIme()?.takeIf { uptimeMillis() < requestDeadlineMs } },
      isCancelled = { state?.cancelled?.get() == true || uptimeMillis() >= requestDeadlineMs },
    )

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
      resultSender.sendFrame(requestId, "cancel_ime_commit_result") { perfTiming ->
        cancelImeCommitResultFrame(
          requestId,
          targetRequestId,
          result.partialApplication,
          result.committedUnits,
          perfTiming,
        )
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
          KeyboardProfilesResult(
            requestId = requestId,
            success = false,
            supportedCatalogVersions = KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS,
            error =
              "No mutually supported keyboard profile catalog version; device supports " +
                KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS.joinToString(", "),
          ),
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
        KeyboardProfilesResult(
          requestId = requestId,
          success = true,
          catalogVersion = catalogVersion,
          supportedCatalogVersions = KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS,
          activeProfileId = activeProfileId,
          profiles = profiles,
        ),
      )
    }
  }

  private suspend fun broadcastCommitTextResult(outcome: CommitTextFrameResult) {
    resultSender.sendFrame(outcome.requestId, "commit_text_result") { perfTiming ->
      commitTextResultFrame(outcome, perfTiming)
    }
  }

  private suspend fun broadcastSetKeyboardProfileResult(
    requestId: String?,
    success: Boolean,
    activeProfileId: String? = null,
    previousProfileId: String? = null,
    error: String? = null,
  ) {
    resultSender.send(requestId, "set_keyboard_profile_result") { perfTiming ->
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
  }

  private suspend fun broadcastKeyboardProfileCatalog(outcome: KeyboardProfilesResult) {
    resultSender.sendFrame(outcome.requestId, "keyboard_profiles_result") { perfTiming ->
      keyboardProfilesResultFrame(outcome, perfTiming)
    }
  }
}

private fun commitResultFrame(
  requestId: String?,
  result: ImeCommitResult,
  totalTimeMs: Long,
  trace: Boolean,
): CommitTextFrameResult =
  CommitTextFrameResult(
    requestId = requestId,
    success = result.success,
    error = result.error,
    totalTimeMs = totalTimeMs,
    partialApplication = result.partialApplication,
    committedUnits = result.committedUnits,
    insertedText = result.insertedText,
    trace = if (trace) result.trace else null,
    editorConsumed = result.editorConsumed,
  )

private fun failedCommitFrame(
  requestId: String?,
  error: String,
  totalTimeMs: Long,
): CommitTextFrameResult =
  CommitTextFrameResult(
    requestId = requestId,
    success = false,
    error = error,
    totalTimeMs = totalTimeMs,
    partialApplication = false,
  )
