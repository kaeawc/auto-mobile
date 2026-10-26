package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import android.view.Display
import dev.jasonpearson.automobile.protocol.PrototypeAppearance
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceOverride
import dev.jasonpearson.automobile.protocol.PrototypeDataResolver
import dev.jasonpearson.automobile.protocol.PrototypeHiddenReason
import dev.jasonpearson.automobile.protocol.PrototypePatchConflict
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot
import dev.jasonpearson.automobile.protocol.PrototypeStatusEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Bounded window/resource budget for concurrently shown prototypes. */
const val MAX_CONCURRENT_PROTOTYPES = 4

/** The CtrlProxy application id, named in errors that tell the host which package to grant. */
const val DEFAULT_CTRL_PROXY_PACKAGE = "dev.jasonpearson.automobile.ctrlproxy"

/** Whether our prototype window is among accessibility windows on [displayId]; null is unknown. */
fun interface PrototypeWindowOnScreen {
  fun isOnScreen(displayId: Int): Boolean?
}

fun interface PrototypeResultSink {
  suspend fun send(requestId: String?, success: Boolean, error: String?)

  suspend fun sendPinned(
    requestId: String?,
    pin: dev.jasonpearson.automobile.protocol.SavedPrototypePinInfo,
  ) = send(requestId, true, null)

  suspend fun sendSaved(
    requestId: String?,
    saved: dev.jasonpearson.automobile.protocol.SavedPrototypeInfo,
  ) = send(requestId, true, null)

  suspend fun sendSavedList(
    requestId: String?,
    entries: List<dev.jasonpearson.automobile.protocol.SavedPrototypeEntry>,
  ) = send(requestId, true, null)

  suspend fun sendRefusal(
    requestId: String?,
    code: dev.jasonpearson.automobile.protocol.SavedPrototypeErrorCode,
    error: String,
  ) = send(requestId, false, error)

  /**
   * A successful `show_prototype` that references assets the device does not have: a warning
   * carried by the same single `prototype_result`, so the host can re-upload. Sinks that predate it
   * drop the list.
   */
  suspend fun sendWithMissingAssets(
    requestId: String?,
    success: Boolean,
    error: String?,
    missingAssets: List<String>,
  ) = send(requestId, success, error)

  /**
   * A successful `show_prototype`, with the mode it resolved to (`prototype_appearance_v1`). Sinks
   * that predate it drop the appearance.
   */
  suspend fun sendShown(
    requestId: String?,
    missingAssets: List<String>,
    appearance: PrototypeAppearance,
    hiddenReason: PrototypeHiddenReason? = null,
  ) =
    if (missingAssets.isEmpty()) send(requestId, true, null)
    else sendWithMissingAssets(requestId, true, null, missingAssets)

  suspend fun sendPatched(
    requestId: String?,
    success: Boolean,
    error: String?,
    revision: Long?,
    conflict: PrototypePatchConflict?,
  ) = send(requestId, success, error)

  /** Show navigation context; the default preserves existing sink implementations. */
  suspend fun sendShownNavigation(
    requestId: String?,
    missingAssets: List<String>,
    appearance: PrototypeAppearance,
    pages: Map<String, Int>,
    stacks: Map<String, PrototypeStackSnapshot>,
    hiddenReason: PrototypeHiddenReason? = null,
  ) = sendShown(requestId, missingAssets, appearance, hiddenReason)

  /** The reply to `clear_prototype_storage`. Sinks that predate it answer a bare success. */
  suspend fun sendCleared(requestId: String?, cleared: Int) = send(requestId, true, null)

  /** The reply to `inspect_prototypes`. Sinks that predate it answer a bare success. */
  suspend fun sendPrototypeStatus(
    requestId: String?,
    prototypes: List<PrototypeStatusEntry>,
    droppedEvents: Long,
  ) = send(requestId, true, null)
}

/**
 * Surfaces keyed by ID, serialized with host mutations. Validation/mapping happen before
 * replacement; rejected requests retain the previous spec/window. Every show carries a full spec
 * whose state is authoritative; the canonical validator supplies key rules and JSON paths. There is
 * no opacity-only wire field.
 */
class PrototypeController(
  private val host: PrototypeHost,
  private val sink: PrototypeResultSink,
  private val onDismissed: suspend () -> Unit = {},
  private val eventSink: PrototypeEventSink = PrototypeEventSink {},
  private val clock: () -> Long = System::currentTimeMillis,
  private val lifecycle: PrototypeLifecycle = PrototypeLifecycle(CoroutinePrototypeScheduler()),
  private val render: (PrototypeSpec) -> PrototypeRequest = { mapPrototypeSpec(it).request() },
  /** Decides whether a non-default display can host the prototype; the default always can. */
  private val displays: PrototypeDisplayProvider = PrototypeDisplayProvider { true },
  /**
   * Drops every uploaded asset when the last surface ends: dismissal or abandonment, unbind,
   * destroy, a dismiss-all with nothing showing, and the last client disconnecting (even with
   * nothing showing, since assets are uploaded before the prototype that uses them). Not called for
   * a show replacement or a temporary lock-screen hide.
   */
  private val clearAssets: () -> Unit = {},
  /** Whether the asset store holds [id]; `show` reports referenced ids that fail. */
  private val hasAsset: (String) -> Boolean = { true },
  /** Decoded-image cache the rendered prototype draws `image` nodes from. */
  private val images: PrototypeImageCache? = null,
  /**
   * Whether this package may add `window.layer: "app"` windows (SYSTEM_ALERT_WINDOW); a request for
   * that layer without it fails before anything is replaced, naming the appop to grant.
   */
  private val appLayerPermitted: () -> Boolean = { true },
  private val packageName: String = DEFAULT_CTRL_PROXY_PACKAGE,
  /** Events a device-persistent prototype produced while no host was connected. */
  private val offlineEvents: PrototypeOfflineEventBuffer = PrototypeOfflineEventBuffer(),
  /** Loaded custom fonts the rendered prototype draws `fontFamily: {asset}` text with. */
  private val fonts: PrototypeFontCache? = null,
  /**
   * Ties a session prototype to the app it was shown over: while another app is in front the window
   * is hidden (state kept, no `dismissed` event) and returns with the app (#10261). Separate from
   * the lock-screen block and from any capture-time hide.
   */
  private val foreground: PrototypeForegroundScope = NoPrototypeForegroundScope,
  /** The device's light or dark setting and dynamic-colour palette, read at every resolve. */
  private val deviceAppearance: PrototypeDeviceAppearance = NoPrototypeDeviceAppearance,
  private val windowOnScreen: PrototypeWindowOnScreen = PrototypeWindowOnScreen { null },
  private val settle: suspend (Long) -> Unit = { delay(it) },
  /** The supplied host handles the first surface; additional surfaces need independent hosts. */
  private val hostFactory: () -> PrototypeHost = { host },
  /**
   * Keeps the values a spec's `storage` block lists across shows (#12522, `prototype_storage_v1`).
   * Null leaves `storage` inert, and the device must not advertise the capability.
   */
  private val storage: PrototypeStoragePersistence? = null,
  /** The transports behind `request` actions (#12528). */
  private val httpClients: PrototypeHttpClients = PrototypeHttpClients.Unavailable,
  /** Where requests wait for their response; they are cancelled when their prototype ends. */
  private val requestScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
  val isShowing: Boolean
    get() = surfaces.values.any { it.host.isShowing }

  /**
   * Whether the prototype on screen is in the application-overlay layer, whose windows the system
   * reports to accessibility as `TYPE_SYSTEM` rather than as an accessibility overlay.
   */
  val isAppLayerShowing: Boolean
    get() =
      surfaces.values.any { it.host.isShowing && it.request.layer == PrototypeWindowLayer.APP }

  /**
   * Placement and opacity of the prototype currently drawn, for the hierarchy capture
   * (`prototype_window_metadata_v1`). Null when nothing is showing or the render model cannot be
   * derived, so the host falls back to bounds. A snapshot read off the controller mutex.
   */
  fun windowMetadata(surfaceId: String? = null): PrototypeWindowMetadata? {
    // Titled windows identify their surface; legacy windows use the most recently shown one.
    val surface =
      (if (surfaceId != null) surfaces[surfaceId]?.takeIf { it.host.isShowing }
      else surfaces.values.lastOrNull { it.host.isShowing }) ?: return null
    val runtime = surface.runtime
    return try {
      val current = runtime.current
      // Opacity follows the mode the window is drawn in, not every mode the spec could reach.
      val shown = surface.theme.value
      prototypeWindowMetadata(
        runtime.renderModel(current),
        dismissBarDrawn = prototypeHostChrome(surface.request).dismissVisible,
        palettes = listOf(prototypeShownPalette(shown)),
        appearance = shown.appearance,
      )
        .copy(motion = runtime.motionActivity.snapshot())
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype window metadata unavailable", error)
      null
    }
  }

  /** True while a prototype exists but is hidden because its app left the foreground. */
  val isSuspendedByForeground: Boolean
    get() = surfaces.values.any { it.foreground.suspended }

  /**
   * Captures with the prototype hidden (#9305). Deliberately outside the controller mutex: a
   * capture must not wait behind a show, and the host serializes captures and restores on its own.
   * A suspended prototype (its app is not in front, #10261) has no window: the capture treats it as
   * not showing and never touches the host, so it cannot re-show it. The host's restore also goes
   * through isBlocked, covering a suspension or lock that lands mid-capture.
   */
  suspend fun <T> withHiddenForCapture(block: suspend () -> T): PrototypeHiddenCapture<T> {
    // Copy-on-write snapshots never wait behind show. Only an entirely suspended set can skip
    // the hosts: a device-persistent surface may still be visible beside a suspended session.
    val snapshot = surfaces.values.toList()
    val hosts =
      if (snapshot.isEmpty()) listOf(host)
      else snapshot.filterNot { it.foreground.suspended }.map { it.host }
    suspend fun capture(index: Int): PrototypeHiddenCapture<T> {
      if (index == hosts.size) return PrototypeHiddenCapture(block(), true)
      val outer = hosts[index].withHiddenForCapture { capture(index + 1) }
      return PrototypeHiddenCapture(
        outer.value.value,
        outer.prototypeExcluded && outer.value.prototypeExcluded,
      )
    }
    return capture(0)
  }

  private val mutex = Mutex()

  /** One cap on requests in flight for every surface this controller shows. */
  private val requestLimiter = PrototypeRequestLimiter()

  private class Surface(
    val runtime: PrototypeRuntime,
    @Volatile var request: PrototypeRequest,
    val theme: MutableStateFlow<PrototypeShownTheme>,
    val appearanceOverride: PrototypeAppearanceOverride?,
    val observerSession: Int,
    val host: PrototypeHost,
    val idle: PrototypeLifecycle,
    val foreground: PrototypeForegroundScope,
    var disconnectPending: Boolean = false,
    var appearanceSyncKey: AppearanceSyncKey? = null,
  )

  // Mutations run under mutex; readers and capture use an immutable ordered snapshot.
  @Volatile private var surfaces: Map<String, Surface> = emptyMap()
  // Retained for existing single-surface callers/tests, now a view of the most recent surface.
  internal val activeRuntime: PrototypeRuntime?
    get() = surfaces.values.lastOrNull { it.runtime.current.active }?.runtime

  private fun surfaceOf(runtime: PrototypeRuntime): Surface? =
    surfaces[runtime.current.spec.id]?.takeIf { it.runtime === runtime }

  // Controller lifetime ledger: same-id show/dismiss/re-show and reconnect never rewind sequences.
  private val sequences = mutableMapOf<String, Long>()
  private val revisions = mutableMapOf<String, Long>()

  private fun nextRevision(id: String): Long =
    ((revisions[id] ?: 0L) + 1L).also { revisions[id] = it }

  private var destroyed = false

  private class AppearanceSyncKey(
    val snapshot: PrototypeRuntimeSnapshot,
    val dark: Boolean,
    val paletteKey: Int,
    val override: PrototypeAppearanceOverride?,
  ) {
    fun matches(other: AppearanceSyncKey): Boolean =
      snapshot === other.snapshot &&
        dark == other.dark &&
        paletteKey == other.paletteKey &&
        override == other.override
  }

  private fun appearanceKey(runtime: PrototypeRuntime) =
    AppearanceSyncKey(
      runtime.current,
      deviceAppearance.dark,
      deviceAppearance.paletteKey,
      surfaceOf(runtime)?.appearanceOverride,
    )

  // Match WebSocketServer.protocolJson; default-valued optional fields are omitted, not null.
  private val json = Json {
    prettyPrint = false
    ignoreUnknownKeys = true
    classDiscriminator = "type"
  }

  /**
   * Always renders the full [spec]. When [spec]'s id is the prototype on screen and [reset] is
   * false, it replaces that prototype in place: it stays on the display it was shown on
   * ([displayId] is ignored) and each pager keeps its page, matched by pager id and clamped to the
   * new page count. Each stack keeps its path with removed screen names dropped (or its start
   * screen when none remain). The new spec's state is authoritative; values the user changed are
   * not carried over. Otherwise (another id, nothing shown, or [reset]) it is a fresh show on
   * [displayId], where null means the default display, exactly as before display targeting.
   *
   * [appearance] stands in for the device's light or dark setting for this show; null follows the
   * device. It belongs to the show, so an in-place show without it follows the device again.
   * [replaceOthers] preserves the legacy replacement policy by default; false retains siblings.
   */
  suspend fun show(
    requestId: String?,
    spec: PrototypeSpec,
    displayId: Int? = null,
    reset: Boolean = false,
    appearance: PrototypeAppearanceOverride? = null,
    replaceOthers: Boolean = true,
  ) =
    execute(requestId) {
      val previous = surfaces[spec.id]
      require(replaceOthers || previous != null || surfaces.size < MAX_CONCURRENT_PROTOTYPES) {
        "Too many prototypes on screen (max $MAX_CONCURRENT_PROTOTYPES): " +
          surfaces.keys.joinToString(", ")
      }
      val inPlace = !reset && previous != null
      val shown =
        display(
          spec,
          replaceOthers = replaceOthers,
          preservePages = inPlace,
          displayId =
            if (inPlace) previous.request.displayId else displayId ?: Display.DEFAULT_DISPLAY,
          appearance = appearance,
        )
      if (surfaceOf(shown.runtime) == null) Outcome()
      else
        Outcome(
          prototypeAssetReferences(shown.runtime.current.spec.root).filterNot(hasAsset),
          shown.theme.value.appearance,
          hiddenReason = shownHiddenReason(shown),
          pages = shown.runtime.current.pages,
          stacks = shown.runtime.current.stacks,
        )
    }

  suspend fun patch(requestId: String?, id: String, baseRevision: Long?, ops: JsonArray) =
    execute(requestId, patchId = id) {
      val runtime = surfaces[id]?.runtime?.takeIf { it.current.active }
      if (runtime == null) Outcome(error = "Unknown prototype id: $id")
      else {
        when (val result = runtime.patch(baseRevision, ops, json, ::validate)) {
          is PrototypeRuntime.PatchResult.Rejected ->
            Outcome(error = result.message, revision = result.revision)
          is PrototypeRuntime.PatchResult.Conflict ->
            Outcome(
              error = "conflict: state changed after baseRevision $baseRevision",
              revision = result.revision,
              conflict = PrototypePatchConflict(result.revision, result.state),
            )
          is PrototypeRuntime.PatchResult.Applied -> {
            try {
              armIdle(runtime)
              val model = runtime.renderModel()
              syncAppearance(runtime, model)
              syncTextFieldFocus(runtime, model)
            } catch (error: CancellationException) {
              throw error
            } catch (error: Exception) {
              Log.w("PrototypeController", "Prototype interaction failed", error)
            }
            Outcome(revision = result.revision)
          }
        }
      }
    }

  suspend fun dismiss(requestId: String?, id: String?, all: Boolean?) =
    execute(requestId) {
      require(all == true || (id != null && surfaces.containsKey(id))) {
        "Unknown prototype id: $id"
      }
      val selected =
        if (all == true) surfaces.values.toList() else listOf(surfaces.getValue(checkNotNull(id)))
      if (selected.isEmpty()) {
        check(host.dismiss()) { "Prototype host failed to dismiss window" }
        releaseAssets()
      } else
        forEachSurface(selected) {
          if (it.runtime.current.active) it.runtime.dismiss(PrototypeDismissReason.AGENT)
          else retire(it, notifyDismissed = true)
        }
      Outcome()
    }

  /** What a request reports beyond success: asset ids the device lacks, and a show's appearance. */
  private data class Outcome(
    val missingAssets: List<String> = emptyList(),
    val appearance: PrototypeAppearance? = null,
    val error: String? = null,
    val revision: Long? = null,
    val conflict: PrototypePatchConflict? = null,
    val hiddenReason: PrototypeHiddenReason? = null,
    val pages: Map<String, Int>? = null,
    val stacks: Map<String, PrototypeStackSnapshot>? = null,
  )

  private fun validate(spec: JsonObject): PrototypeSpec =
    when (val validation = PrototypeSpecValidator.validate(spec.toString())) {
      is PrototypeSpecValidation.Failure ->
        error("${validation.error.path}: ${validation.error.message}")
      is PrototypeSpecValidation.Success -> validate(validation.spec)
    }

  private fun validate(spec: PrototypeSpec): PrototypeSpec {
    guardPrototypeTree(spec.root)
    requireResolvedPrototypeAnchors(spec.root)
    val validated =
      when (val validation = PrototypeSpecValidator.validate(json.encodeToString(spec))) {
        is PrototypeSpecValidation.Failure ->
          error("${validation.error.path}: ${validation.error.message}")
        is PrototypeSpecValidation.Success -> validation.spec
      }
    val resolved = PrototypeDataResolver.resolve(validated)
    guardPrototypeTree(resolved.root)
    if (resolved.root !== validated.root) requireResolvedPrototypeAnchors(resolved.root)
    return validated
  }

  /** Whether a spec with stored values applied still passes the same validation as a shown one. */
  private fun restoredSpecFits(restored: PrototypeSpec): Boolean =
    try {
      validate(restored)
      true
    } catch (error: IllegalArgumentException) {
      Log.w("PrototypeController", "Restored prototype values rejected: ${error.message}")
      false
    } catch (error: IllegalStateException) {
      Log.w("PrototypeController", "Restored prototype values rejected: ${error.message}")
      false
    }

  /** Snapshot decision, like windowMetadata: no controller mutex is acquired. */
  fun hiddenReason(displayId: Int, ownWindowCaptured: Boolean?): PrototypeHiddenReason? =
    surfaces.values
      .lastOrNull {
        it.runtime.current.active &&
          !it.foreground.suspended &&
          (lifecycle.isBlocked() || it.request.displayId == displayId)
      }
      ?.let { hiddenReason(it, ownWindowCaptured) }

  private fun hiddenReason(
    surface: Surface,
    ownWindowCaptured: Boolean?,
  ): PrototypeHiddenReason? =
    when {
      !surface.runtime.current.active || surface.foreground.suspended -> null
      lifecycle.isBlocked() -> PrototypeHiddenReason.DEVICE_BLOCKED
      surface.host.isHiddenForCapture -> null
      surface.host.isShowing &&
        surface.request.layer == PrototypeWindowLayer.APP &&
        ownWindowCaptured == false -> PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN
      else -> null
    }

  private suspend fun shownHiddenReason(surface: Surface): PrototypeHiddenReason? {
    hiddenReason(surface, null)?.let {
      return it
    }
    if (
      !surface.host.isShowing ||
        surface.request.layer != PrototypeWindowLayer.APP ||
        surface.foreground.suspended ||
        surface.host.isHiddenForCapture
    )
      return null
    repeat(5) { probe ->
      val captured = windowOnScreen.isOnScreen(surface.request.displayId)
      if (captured != false) return hiddenReason(surface, captured)
      if (probe < 4) settle(100L)
    }
    return hiddenReason(surface, false)
  }

  /** The default display is always present; any other must be connected, or nothing is replaced. */
  private fun requireDisplayAvailable(displayId: Int) {
    displays.unsupportedReason(displayId)?.let { throw IllegalArgumentException(it) }
    require(displayId == Display.DEFAULT_DISPLAY || displays.isAvailable(displayId)) {
      "Unknown or disconnected display: $displayId"
    }
  }

  private suspend fun display(
    spec: PrototypeSpec,
    replaceOthers: Boolean,
    preservePages: Boolean = false,
    displayId: Int = Display.DEFAULT_DISPLAY,
    appearance: PrototypeAppearanceOverride? = null,
  ): Surface {
    val authored = validate(spec)
    // A same-id show reads the document the shown prototype is about to have written.
    surfaces[spec.id]?.runtime?.flushStorage()
    // A flush the disk refused leaves values the old session still owes; they carry over.
    val unsaved = surfaces[spec.id]?.runtime?.storage?.unsavedValues()
    val opened =
      storage?.prepare(authored, unsaved, ::restoredSpecFits)
        ?: PrototypeStorageOpen(authored, null)
    val validated = opened.spec
    val request =
      render(validated)
        .copy(
          displayId = displayId,
          chrome = prototypeWindowChrome(validated),
          surfaceId = validated.id,
        )
    requireDisplayAvailable(displayId)
    requireLayerPermitted(request.layer)
    val previous = surfaces[spec.id]
    val reused = previous ?: if (replaceOthers) surfaces.values.lastOrNull() else null
    val surfaceHost =
      reused?.host ?: if (surfaces.values.none { it.host === host }) host else hostFactory()
    require(reused != null || surfaces.values.none { it.host === surfaceHost }) {
      "Prototype host factory must create an independent host"
    }
    val scope = reused?.foreground ?: if (surfaceHost === host) foreground else foreground.fork()
    val idle = reused?.idle ?: lifecycle.fork()
    val observerSession = lifecycle.observerSession()
    lateinit var runtime: PrototypeRuntime
    runtime =
      PrototypeRuntime(
        validated,
        if (isDevicePersistent(validated)) offlineAwareSink else eventSink,
        clock,
        nextSequence = {
          val next = (sequences[validated.id] ?: 0L) + 1
          sequences[validated.id] = next
          next
        },
        requestDismiss = { removeSurface(runtime) },
        previousPages =
          if (preservePages) previous?.runtime?.current?.pages.orEmpty() else emptyMap(),
        initialRevision = nextRevision(validated.id),
        nextRevision = { nextRevision(validated.id) },
        previousStacks =
          if (preservePages) previous?.runtime?.current?.stacks.orEmpty() else emptyMap(),
        storage = opened.session,
        httpClients = httpClients,
        requestScope = requestScope,
        // A response lands between interactions, never in the middle of one.
        exclusively = { block -> settleRequest(runtime, block) },
        requestLimiter = requestLimiter,
      )
    val mappedSpec = runtime.renderModel()
    val theme = MutableStateFlow(shownTheme(mappedSpec, appearance))
    val interactive =
      request.copy(
        hasTextField = mappedSpec.hasTextField,
        hasStackBack = runtime.hasPoppableStack(mappedSpec),
        // Each window keeps its own focus flags; cross-window focus coordination is a follow-up.
        isSuspended = { scope.suspended },
        bringToFront = reused != null && surfaces.values.lastOrNull() !== reused,
        theme = theme,
        onHostDismiss = { interact(runtime, PrototypeInteraction.HostDismiss) },
        onHostBack = { interact(runtime, PrototypeInteraction.Back) },
        content = {
          PrototypeRuntimeContent(runtime, images, fonts) { interaction ->
            interact(runtime, interaction)
          }
        },
      )
    // A device-persistent prototype is a standalone mock with no app to follow.
    val scopeBefore = scope.capture()
    if (isDevicePersistent(validated)) scope.release() else scope.anchor()
    val blocked = lifecycle.isBlocked() || scope.suspended
    // A rejected or throwing host leaves the previous window up, so it keeps its own scoping.
    try {
      check(
        if (blocked) surfaceHost.dismiss()
        else if (reused != null) surfaceHost.replace(interactive)
        else surfaceHost.show(interactive),
      ) {
        "Prototype host failed to render window"
      }
    } catch (error: Throwable) {
      scope.restore(scopeBefore)
      throw error
    }
    // The accepted window is the first point the stored document may change.
    opened.commit()
    // Its unsaved values live on in the new session; it must not write them again behind it.
    if (previous != null) previous.runtime.storage?.invalidate()
    // Render acceptance precedes replacing records. Refused renders keep all old timers/runtime.
    val retiring = if (replaceOthers) surfaces.values.filter { it !== reused } else emptyList()
    reused?.runtime?.flushStorage()
    // A same-id show without a reset keeps its requests in flight; a reset or another id cancels.
    if (preservePages && reused === previous) reused?.runtime?.handOverRequests(runtime)
    reused?.runtime?.close()
    idle.cancel()
    val retainedRequest =
      if (interactive.bringToFront) interactive.copy(bringToFront = false) else interactive
    val surface =
      Surface(
        runtime,
        retainedRequest,
        theme,
        appearance,
        observerSession,
        surfaceHost,
        idle,
        scope,
        appearanceSyncKey =
          AppearanceSyncKey(
            runtime.current,
            theme.value.appearance.deviceDark,
            theme.value.paletteKey,
            appearance,
          ),
      )
    surfaces =
      LinkedHashMap(surfaces).apply {
        reused?.let { remove(it.runtime.current.spec.id) }
        remove(validated.id)
        put(validated.id, surface)
      }
    armIdle(runtime)
    // The accepted show succeeds even if a sibling host cannot detach. Its closed runtime stays
    // addressable only for host cleanup retries, never as a live inspected surface.
    forEachSurface(retiring) { retire(it) }
    if (blocked && !isShowing) notifyDetached()
    // A queued show can run after the session's last client has left.
    if (lifecycle.clientCount() == 0 && !runtime.persistent) dismissForDisconnect(runtime)
    return surface
  }

  /** Replacement closes silently, just as the former single runtime did. */
  private suspend fun retire(surface: Surface, notifyDismissed: Boolean = false) {
    surface.runtime.flushStorage()
    surface.runtime.close()
    surface.idle.cancel()
    surface.foreground.release()
    val wasShowing = isShowing
    try {
      check(surface.host.dismiss()) { "Prototype host failed to dismiss window" }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeController", "Retired prototype host teardown failed", error)
    }
    if (!surface.host.isShowing) surfaces = surfaces.filterValues { it !== surface }
    if (notifyDismissed && wasShowing && !isShowing) notifyDetached()
    if (surfaces.isEmpty()) releaseAssets()
  }

  private val PrototypeRuntime.persistent: Boolean
    get() = isDevicePersistent(current.spec)

  private fun shownTheme(
    model: PrototypeRenderModel,
    override: PrototypeAppearanceOverride?,
    dark: Boolean = deviceAppearance.dark,
    paletteKey: Int = deviceAppearance.paletteKey,
  ): PrototypeShownTheme =
    PrototypeShownTheme(
      model.root,
      model.theme,
      prototypeResolveAppearance(model.root, model.theme, dark, override),
      paletteKey,
    )

  /**
   * Resolves the active show's theme again from [model], the live tree: after an interaction (a
   * pager page or a `styleWhen` state can change the background the mode is inferred from) and
   * after a configuration change (the device setting or its palette). The one flow feeds host
   * chrome and content, so both re-theme together, with authored state, pager pages and text fields
   * untouched. A changed mode sends exactly one `appearance_changed` event; an unchanged one sends
   * nothing. Runs under [mutex].
   */
  private suspend fun syncAppearance(
    runtime: PrototypeRuntime,
    model: PrototypeRenderModel,
    key: AppearanceSyncKey = appearanceKey(runtime),
  ) {
    val surface = surfaceOf(runtime) ?: return
    val theme = surface.theme
    surface.appearanceSyncKey = null
    val previous = theme.value
    val next = shownTheme(model, key.override, key.dark, key.paletteKey)
    if (next != previous) {
      theme.value = next
      if (next.appearance.mode != previous.appearance.mode)
        runtime.appearanceChanged(next.appearance)
    }
    // Record only after both resolution and any event delivery succeeded.
    surface.appearanceSyncKey = key
  }

  /**
   * A device-persistent prototype keeps emitting with no host attached. Those events wait in
   * [offlineEvents] and go out, oldest first, ahead of the next live event. Runs under [mutex].
   */
  private val offlineAwareSink = PrototypeEventSink { event ->
    // A live event never overtakes an older held one: the host ignores lower sequences.
    if (lifecycle.clientCount() == 0 || !replayOfflineEvents()) offlineEvents.add(event)
    else eventSink.send(event)
  }

  /**
   * Delivers what was buffered while no host was connected. An event leaves the buffer only once it
   * is handed to the sink: when delivery fails, or the host goes away mid-replay, that event and
   * the rest are put back for the next connect or inspect. Returns whether everything went out.
   */
  private suspend fun replayOfflineEvents(): Boolean {
    val pending = offlineEvents.drain()
    for ((index, event) in pending.withIndex()) {
      if (lifecycle.clientCount() == 0) {
        offlineEvents.restore(pending.subList(index, pending.size))
        return false
      }
      try {
        eventSink.send(event)
      } catch (error: CancellationException) {
        offlineEvents.restore(pending.subList(index, pending.size))
        throw error
      } catch (error: Exception) {
        Log.w("PrototypeController", "Buffered prototype event delivery failed", error)
        offlineEvents.restore(pending.subList(index, pending.size))
        return false
      }
    }
    return true
  }

  private fun requireLayerPermitted(layer: PrototypeWindowLayer) =
    require(layer != PrototypeWindowLayer.APP || appLayerPermitted()) {
      "window.layer: app needs Android 8.0+ and SYSTEM_ALERT_WINDOW for $packageName, which is " +
        "not granted. Grant it with `adb shell appops set $packageName SYSTEM_ALERT_WINDOW " +
        "allow`, or omit window.layer to use the system layer."
    }

  /** Shared by dismiss_prototype and this runtime's own dismiss action, under mutex. */
  private suspend fun removeSurface(runtime: PrototypeRuntime): Boolean {
    val surface = surfaceOf(runtime) ?: return true
    val wasShowing = isShowing
    if (!surface.host.dismiss()) return false
    surfaces = surfaces.filterValues { it !== surface }
    surface.foreground.release()
    surface.idle.cancel()
    if (wasShowing && !isShowing) notifyDetached()
    if (surfaces.isEmpty()) releaseAssets()
    return true
  }

  private suspend fun notifyDetached() {
    try {
      onDismissed()
    } catch (error: Exception) {
      // Removal succeeded; ancillary highlight cleanup must not suppress a terminal prototype
      // event.
      Log.w("PrototypeController", "Prototype highlight cleanup failed", error)
    }
  }

  /** Asset cleanup is ancillary: it must never suppress a dismissal, event or lifecycle step. */
  private fun releaseAssets() {
    try {
      clearAssets()
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype asset cleanup failed", error)
    }
  }

  internal suspend fun interact(runtime: PrototypeRuntime, interaction: PrototypeInteraction) =
    mutex.withLock {
      if (destroyed || !runtime.current.active || surfaceOf(runtime) == null) return@withLock
      PrototypeTrace.asyncSection(PrototypeTrace.INTERACT) {
        try {
          // Compose reports its initial/restored settled page; that is rendering, not idle
          // activity.
          if (
            interaction !is PrototypeInteraction.PagerMotion ||
              interaction.scrolling ||
              runtime.current.pages[interaction.pager] != interaction.page
          )
            armIdle(runtime)
          runtime.handle(interaction)
          syncAfterChange(runtime)
        } catch (error: CancellationException) {
          throw error
        } catch (error: Exception) {
          Log.w("PrototypeController", "Prototype interaction failed", error)
        }
      }
    }

  /** Re-resolves the appearance and the focused field after the runtime changed the spec. */
  private suspend fun syncAfterChange(runtime: PrototypeRuntime) {
    if (surfaceOf(runtime) == null || !runtime.current.active) return
    val model = runtime.renderModel()
    PrototypeTrace.asyncSection(PrototypeTrace.SYNC_APPEARANCE) {
      syncAppearance(runtime, model)
      syncTextFieldFocus(runtime, model)
    }
  }

  /**
   * A request's response, applied under the same lock as a tap and followed by the same appearance
   * and focus sync, because its writes and follow-up actions change the spec like one.
   */
  private suspend fun settleRequest(runtime: PrototypeRuntime, apply: suspend () -> Unit) =
    mutex.withLock {
      if (destroyed || !runtime.current.active || surfaceOf(runtime) == null) return@withLock
      try {
        apply()
        syncAfterChange(runtime)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("PrototypeController", "Prototype request completion failed", error)
      }
    }

  /** [action]'s missing asset ids are reported as a warning, never as a failure. */
  private suspend fun execute(
    requestId: String?,
    patchId: String? = null,
    action: suspend () -> Outcome,
  ) = mutex.withLock {
    var outcome = Outcome()
    val error =
      try {
        check(!destroyed) { "Prototype host destroyed" }
        outcome = action()
        outcome.error
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("PrototypeController", "Prototype request failed", error)
        error.message ?: "Prototype request failed (${error.javaClass.simpleName})"
      }
    val missing = outcome.missingAssets
    val appearance = outcome.appearance
    if (patchId != null) {
      val revision =
        outcome.revision ?: surfaces[patchId]?.runtime?.current?.takeIf { it.active }?.revision
      sink.sendPatched(requestId, error == null, error, revision, outcome.conflict)
    } else if (error == null && appearance != null)
      sink.sendShownNavigation(
        requestId,
        missing,
        appearance,
        outcome.pages.orEmpty(),
        outcome.stacks.orEmpty(),
        outcome.hiddenReason,
      )
    else if (missing.isEmpty()) sink.send(requestId, error == null, error)
    else sink.sendWithMissingAssets(requestId, error == null, error, missing)
  }

  private fun armIdle(
    runtime: PrototypeRuntime,
    delayMillis: Long = lifecycle.ttlMillis,
    retriesLeft: Int = PROTOTYPE_DISMISS_MAX_RETRIES,
  ) {
    val surface = surfaceOf(runtime) ?: return
    val idle = surface.idle
    // A device-persistent prototype is a standalone mock with nobody to re-show it: never idle out.
    if (!runtime.current.active || runtime.persistent) {
      idle.cancel()
      return
    }
    idle.arm(delayMillis) { token ->
      signal {
        if (surfaceOf(runtime) === surface && idle.isCurrent(token)) {
          try {
            runtime.dismiss(PrototypeDismissReason.TTL)
          } catch (error: CancellationException) {
            throw error
          } catch (error: Exception) {
            // The one-shot expiry is spent; re-arm (bounded) so a failed removal is not final.
            if (retriesLeft > 0 && surfaceOf(runtime) === surface)
              armIdle(runtime, PROTOTYPE_DISMISS_RETRY_MILLIS, retriesLeft - 1)
            throw error
          }
        }
      }
    }
  }

  /** Ends [runtime] for a gone session; a failed removal is logged and retried by [signal]. */
  private suspend fun dismissForDisconnect(runtime: PrototypeRuntime) {
    try {
      runtime.dismiss(PrototypeDismissReason.DISCONNECT)
      surfaceOf(runtime)?.disconnectPending = false
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      surfaceOf(runtime)?.disconnectPending = true
      Log.w("PrototypeController", "Prototype disconnect dismissal failed", error)
    }
  }

  /**
   * Answers `inspect_prototypes`: delivers any buffered events first, then reports every prototype
   * the device is showing, so a host that lost its status (a released session, a new daemon) can
   * adopt it again. The wire order is the events, then the single `prototype_result`.
   */
  suspend fun inspect(requestId: String?) = mutex.withLock {
    try {
      check(!destroyed) { "Prototype host destroyed" }
      // Reporting lastSequence while events are still held would make the host skip them as
      // duplicates on the next inspect, so an incomplete replay fails this inspect instead.
      check(replayOfflineEvents()) {
        "Buffered prototype events could not be delivered; the device kept them, retry inspect"
      }
      val prototypes = surfaces.values.filter { it.runtime.current.active }.map { statusOf(it) }
      sink.sendPrototypeStatus(requestId, prototypes, offlineEvents.dropped)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype inspect failed", error)
      sink.send(requestId, false, error.message ?: "Prototype inspect failed")
    }
  }

  /**
   * Answers `clear_prototype_storage`: wipes the values stored for [id], from the shown prototype's
   * session when there is one (which also forgets its pending write) and from disk otherwise. The
   * prototype on screen is unchanged; the next show of the id starts from the spec's values.
   */
  suspend fun clearStorage(requestId: String?, id: String) = mutex.withLock {
    try {
      check(!destroyed) { "Prototype host destroyed" }
      val cleared = clearStoredValues(id)
      sink.sendCleared(requestId, cleared)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype storage clear failed", error)
      sink.send(requestId, false, error.message ?: "Prototype storage clear failed")
    }
  }

  /** The stored keys removed for [id]; callers hold no controller state of their own. */
  suspend fun clearStoredValues(id: String): Int {
    val persistence = storage ?: return 0
    val live = surfaces[id]?.runtime?.storage
    return live?.clear() ?: persistence.clear(id)
  }

  private suspend fun statusOf(surface: Surface): PrototypeStatusEntry {
    val runtime = surface.runtime
    val id = runtime.current.spec.id
    return PrototypeStatusEntry(
      id = id,
      persistent = runtime.persistent,
      state = runtime.current.state.toMap(),
      data = runtime.current.spec.data,
      pages = runtime.current.pages.toMap(),
      stacks = runtime.current.stacks.toMap(),
      lastSequence = sequences[id] ?: 0L,
      suspended = surface.foreground.suspended,
      hiddenReason = shownHiddenReason(surface),
      appearance = surface.theme.value.appearance,
      storage = runtime.storage?.report(),
    )
  }

  /**
   * A host connected: hand it the events a device-persistent prototype buffered while it was away.
   */
  suspend fun onClientConnected() =
    signal(retryDisconnect = false) {
      replayOfflineEvents()
    }

  /** Local override until a daemon/tool TTL field exists; no new protocol field is invented. */
  suspend fun setIdleTtlMillis(millis: Long) = mutex.withLock {
    lifecycle.ttlMillis = millis
    forEachSurface(surfaces.values.toList()) {
      it.idle.ttlMillis = millis
      armIdle(it.runtime)
    }
  }

  suspend fun onClientCountChanged(count: Int, observerSession: Int? = null) =
    signal(retryDisconnect = false) {
      require(count >= 0) { "Client count must be nonnegative" }
      forEachSurface(surfaces.values.toList()) { surface ->
        if (
          !surface.runtime.persistent &&
            count == 0 &&
            (observerSession == null || observerSession == surface.observerSession)
        )
          dismissForDisconnect(surface.runtime)
      }
      // Persistent surfaces and remaining observers keep their shared assets.
      if (
        count == 0 &&
          surfaces.isEmpty() &&
          (observerSession == null || observerSession == lifecycle.observerSession())
      )
        releaseAssets()
    }

  /**
   * Rotation/density changes keep the same runtime and Compose tree; hiding retains authored state.
   * The prototype's own display going away dismisses it even when the caller does not know that. A
   * night-mode or palette change re-themes the same tree, hidden or not (#11221).
   */
  suspend fun onConfigurationChanged(displayAvailable: Boolean = true) = signal {
    forEachSurface(surfaces.values.toList()) { surface ->
      resyncAppearance(surface.runtime)
      applyWindowDecision(surface.runtime, displayAvailable && ownDisplayAvailable(surface))
    }
  }

  /** A failed re-theme keeps the mode already drawn and must not skip the window decision. */
  private suspend fun resyncAppearance(runtime: PrototypeRuntime) {
    try {
      val key = appearanceKey(runtime)
      if (surfaceOf(runtime)?.appearanceSyncKey?.matches(key) == true) return
      syncAppearance(runtime, runtime.renderModel(), key)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype appearance update failed", error)
    }
  }

  /**
   * A display callback. Only the prototype's own display matters: its removal dismisses with
   * `teardown` rather than moving the content to another display, and a change relayouts. Other
   * displays' transitions are not this prototype's business.
   */
  suspend fun onDisplayTransition(displayId: Int, removed: Boolean) = signal {
    forEachSurface(surfaces.values.filter { it.request.displayId == displayId }) { surface ->
      applyWindowDecision(surface.runtime, !removed && ownDisplayAvailable(surface))
    }
  }

  private fun ownDisplayAvailable(surface: Surface): Boolean =
    surface.request.displayId == Display.DEFAULT_DISPLAY ||
      displays.isAvailable(surface.request.displayId)

  private suspend fun applyWindowDecision(runtime: PrototypeRuntime, displayAvailable: Boolean) {
    if (!runtime.current.active) return
    val surface = surfaceOf(runtime) ?: return
    when (
      prototypeWindowDecision(
        displayAvailable,
        lifecycle.isBlocked() || surface.foreground.suspended,
      )
    ) {
      PrototypeWindowDecision.DISMISS -> runtime.dismiss(PrototypeDismissReason.TEARDOWN)
      PrototypeWindowDecision.HIDE -> {
        val wasShowing = isShowing
        check(surface.host.dismiss()) { "Prototype host failed to hide window" }
        if (wasShowing && !isShowing) notifyDetached()
      }
      PrototypeWindowDecision.RELAYOUT -> relayoutOrRestore(runtime)
    }
  }

  /**
   * A window the platform reports detached is cleared by the host, so a failed relayout with
   * nothing showing means the prototype vanished underneath us: re-show the authored request. If
   * the window cannot come back the runtime ends once, as teardown, instead of lingering
   * windowless.
   */
  private suspend fun relayoutOrRestore(runtime: PrototypeRuntime) {
    val surface = surfaceOf(runtime) ?: return
    val host = surface.host
    val request = surface.request
    if (host.isShowing) {
      if (host.relayout()) {
        if (!host.isShowing && !isShowing) notifyDetached()
        return
      }
      // Still attached: a retryable platform failure, so keep the window and runtime as they are.
      check(!host.isShowing) { "Prototype host failed to re-layout window" }
    }
    if (restoreWindow(surface.host, request)) return
    if (lifecycle.isBlocked() || surface.foreground.suspended) {
      if (!isShowing) notifyDetached()
    } else abandon(runtime)
  }

  /**
   * A display can still be listed yet unable to take a window (its window context fails), which
   * makes the host throw instead of returning false. That is the same "cannot come back" outcome:
   * report it as false so the caller abandons rather than leaving the runtime windowless.
   */
  private suspend fun restoreWindow(host: PrototypeHost, request: PrototypeRequest): Boolean =
    try {
      host.show(request)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeController", "Prototype window could not be restored", error)
      false
    }

  /**
   * A visible text field in the CURRENT tree may hold input focus, so a page swipe, tab change or
   * sheet open/close can flip it. Stack navigation also takes focus while a visible eligible stack
   * can pop; otherwise Back and key input to the app behind would be swallowed. A failed flip keeps
   * the old request and is retried on the next change.
   */
  private suspend fun syncTextFieldFocus(runtime: PrototypeRuntime, model: PrototypeRenderModel) {
    val surface = surfaceOf(runtime) ?: return
    val host = surface.host
    val request = surface.request
    val stackBack = runtime.hasPoppableStack(model)
    var updated = request
    if (stackBack != request.hasStackBack) {
      if (host.setStackBackEnabled(stackBack) || !host.isShowing) {
        updated = request.copy(hasStackBack = stackBack)
        surface.request = updated
      } else Log.w("PrototypeController", "Prototype host failed to update stack Back focusability")
    }
    val visible = model.hasTextField
    if (visible == updated.hasTextField) return
    // A window cleared as detached is restored from the surface request, so record the change for
    // it.
    if (host.setTextFieldVisible(visible) || !host.isShowing)
      surface.request = updated.copy(hasTextField = visible)
    else Log.w("PrototypeController", "Prototype host failed to update window focusability")
  }

  /** Terminal teardown for a window that cannot be shown again: exactly one `dismissed` event. */
  private suspend fun abandon(runtime: PrototypeRuntime) {
    val surface = surfaceOf(runtime) ?: return
    surfaces = surfaces.filterValues { it !== surface }
    surface.foreground.release()
    surface.idle.cancel()
    if (surfaces.isEmpty()) {
      notifyDetached()
      releaseAssets()
    }
    runtime.finishDismissal(PrototypeDismissReason.TEARDOWN)
  }

  /**
   * Service unbind: ends the active prototype as teardown but keeps the controller reusable,
   * because Android can rebind the same service instance before onDestroy. Failed removal stays
   * retryable.
   */
  suspend fun dismissForUnbind() = signal {
    if (surfaces.isEmpty()) {
      check(host.dismiss()) { "Prototype host failed to dismiss window" }
      releaseAssets()
    } else
      forEachSurface(surfaces.values.toList()) {
        it.runtime.dismiss(PrototypeDismissReason.TEARDOWN)
      }
  }

  /**
   * Complete the batch before surfacing its first failure, so other surfaces are never stranded.
   */
  private suspend fun forEachSurface(selected: List<Surface>, action: suspend (Surface) -> Unit) {
    var failure: Exception? = null
    for (surface in selected) {
      try {
        action(surface)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("PrototypeController", "Prototype surface operation failed", error)
        if (failure == null) failure = error
      }
    }
    failure?.let { throw it }
  }

  private suspend fun signal(retryDisconnect: Boolean = true, action: suspend () -> Unit) =
    mutex.withLock {
      if (destroyed) return@withLock
      try {
        for (surface in surfaces.values.toList()) {
          if (!surface.runtime.current.active) retire(surface, notifyDismissed = true)
        }
        if (retryDisconnect)
          for (surface in surfaces.values.toList()) {
            if (surface.disconnectPending) dismissForDisconnect(surface.runtime)
          }
        action()
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w("PrototypeController", "Prototype lifecycle signal failed", error)
      }
    }

  /** Run from a teardown scope independent of the cancelled service scope; no blocking join. */
  suspend fun destroy() = mutex.withLock {
    destroyed = true
    val selected = surfaces.values.toList()
    val remaining = linkedMapOf<String, Surface>()
    lifecycle.cancel()
    for (surface in selected) {
      surface.idle.cancel()
      surface.foreground.release()
      try {
        check(surface.host.destroy()) { "Prototype host failed to destroy window" }
      } catch (error: Exception) {
        Log.w("PrototypeController", "Prototype teardown failed", error)
        // Keep a failed, still attached host addressable for a later destroy retry. Its runtime
        // still becomes terminal below, so it cannot emit or accept another interaction.
        if (surface.host.isShowing) remaining[surface.runtime.current.spec.id] = surface
      } finally {
        try {
          surface.runtime.finishDismissal(PrototypeDismissReason.TEARDOWN)
        } catch (error: Exception) {
          // Teardown is best effort once the sink has shut down; the runtime is already terminal.
          Log.w("PrototypeController", "Prototype teardown event delivery failed", error)
        }
      }
    }
    if (selected.none { it.host === host }) {
      try {
        check(host.destroy()) { "Prototype host failed to destroy window" }
      } catch (error: Exception) {
        Log.w("PrototypeController", "Prototype unused host teardown failed", error)
      }
    }
    surfaces = remaining
    foreground.release()
    if (selected.isNotEmpty() && remaining.isEmpty()) notifyDetached()
    releaseAssets()
  }
}
