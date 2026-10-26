package dev.jasonpearson.automobile.prototype

import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.jasonpearson.automobile.ctrlproxy.prototype.BitmapPrototypeImageDecoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.ComposePrototypeFontLoader
import dev.jasonpearson.automobile.ctrlproxy.prototype.CoroutinePrototypeScheduler
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeDismissReason as InternalPrototypeDismissReason
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeFontCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeImageCache
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntimeContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStoragePersistence
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Embeds a validated prototype. The composition owns its runtime and cancels requests when [spec]
 * changes or it leaves composition. Declared storage keys restore before drawing and flush on
 * lifecycle stop and disposal. Keep [assets], [storage] and [network] stable; replacing one reloads
 * the runtime. Callback changes do not reload it. No daemon or HTTP stack is required. After
 * dismissal, content stays removed until [spec] changes or the caller uses `key()` to create a new
 * composition identity.
 *
 * @param spec Complete prototype JSON; invalid/unsupported input draws only [onError].
 * @param modifier Applied to the embedded content, including error content.
 * @param assets Custom image and font bytes, addressed by asset id.
 * @param storage Persistence for declared storage keys; disabled by default.
 * @param network App-owned request transports; disabled by default.
 * @param onEvent Receives typed runtime events on the main thread.
 * @param onDismiss Receives the reason for an authored or user dismissal, once.
 * @param handleBack Opt in to dismissing active content on back; false leaves back to the app.
 * @param onError Content for load failures. Validation has no separate capability-requirement list.
 */
@Composable
// Compose callers configure the public API through named, optional parameters.
@Suppress("LongParameterList")
fun AutoMobilePrototype(
  spec: String,
  modifier: Modifier = Modifier,
  assets: PrototypeAssets = PrototypeAssets.None,
  storage: PrototypeStorage = PrototypeStorage.None,
  network: PrototypeNetwork = remember { PrototypeNetwork() },
  onEvent: (PrototypeEvent) -> Unit = {},
  onDismiss: (PrototypeDismissReason) -> Unit = {},
  handleBack: Boolean = false,
  onError: @Composable (PrototypeLoadError) -> Unit = { DefaultPrototypeError(it) },
) {
  val validation = remember(spec) { PrototypeSpecValidator.validate(spec) }
  Box(modifier) {
    when (validation) {
      is PrototypeSpecValidation.Failure ->
        onError(PrototypeLoadError.Invalid(validation.error.path, validation.error.message))
      is PrototypeSpecValidation.Success ->
        EmbeddedPrototype(
          EmbeddedInput(spec, validation.spec, assets, storage, network),
          EmbeddedCallbacks(onEvent, onDismiss),
          handleBack,
          onError,
        )
    }
  }
}

internal class EmbeddedPrototypeEnvironment(
  val io: CoroutineDispatcher = Dispatchers.IO,
  val clock: () -> Long = System::currentTimeMillis,
  val scope: CoroutineScope? = null,
  val requestId: () -> String = { UUID.randomUUID().toString() },
  val host: EmbeddedPrototypeHost? = null,
)

internal val LocalEmbeddedPrototypeEnvironment = compositionLocalOf {
  EmbeddedPrototypeEnvironment()
}

private class EmbeddedCallbacks(
  val event: (PrototypeEvent) -> Unit,
  val dismiss: (PrototypeDismissReason) -> Unit,
) {
  fun send(event: PrototypeEvent) {
    this.event(event)
    if (event.kind == PrototypeEventKind.DISMISSED) {
      val reason = event.payload?.jsonObject?.get("reason")?.jsonPrimitive?.content
      when (reason) {
        InternalPrototypeDismissReason.USER.wireValue -> dismiss(PrototypeDismissReason.USER)
        else -> Unit
      }
    }
  }
}

private class EmbeddedSession(
  val runtime: PrototypeRuntime,
  val images: PrototypeImageCache,
  val fonts: PrototypeFontCache,
)

private data class EmbeddedInput(
  val source: String,
  val spec: PrototypeSpec,
  val assets: PrototypeAssets,
  val storage: PrototypeStorage,
  val network: PrototypeNetwork,
)

@Composable
private fun EmbeddedPrototype(
  input: EmbeddedInput,
  callbacks: EmbeddedCallbacks,
  handleBack: Boolean,
  onError: @Composable (PrototypeLoadError) -> Unit,
) {
  val context = LocalContext.current.applicationContext
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val environment = LocalEmbeddedPrototypeEnvironment.current
  val compositionScope = rememberCoroutineScope()
  val scope = environment.scope ?: compositionScope
  val host = environment.host
  val latestCallbacks by rememberUpdatedState(callbacks)
  val interactions = remember(environment) { environment.host?.interactions ?: Mutex() }
  // One lock also orders the old session's dispose flush before a replacement restores storage.
  val owner =
    remember(input, environment) { EmbeddedOwner(input.assets, interactions, environment.io) }
  LaunchedEffect(owner) {
    interactions.withLock {
      owner.open(
        EmbeddedConfiguration(
          input.spec,
          input.storage,
          input.network,
          scope,
          environment,
          context.cacheDir,
        ),
      ) {
        environment.host?.eventSink?.send(it)
        latestCallbacks.send(it)
      }
    }
  }
  if (host == null) EmbeddedLifetime(owner, lifecycle, scope, interactions)
  else EmbeddedHostLifetime(owner, host, lifecycle)
  val session = owner.session
  if (session != null) {
    val active by session.runtime.snapshots.collectAsState()
    if (handleBack) {
      BackHandler(enabled = active.active) {
        scope.launch { interactions.withLock { session.runtime.dismiss() } }
      }
    }
    PrototypeRuntimeContent(session.runtime, session.images, session.fonts) {
      if (host == null) interactions.withLock { session.runtime.handle(it) }
      else host.onInteraction(it, session.runtime)
    }
    SideEffect { if (host?.isCurrent?.invoke() == true) host.onReady() }
  }
  owner.error?.let { onError(it) }
}

internal object PrototypeTimerLifecycle {
  fun observer(
    scope: CoroutineScope,
    interactions: Mutex,
    runtime: () -> PrototypeRuntime?,
  ): LifecycleEventObserver = LifecycleEventObserver { _, event ->
    if (event == Lifecycle.Event.ON_START || event == Lifecycle.Event.ON_STOP) {
      scope.launch(NonCancellable, start = CoroutineStart.UNDISPATCHED) {
        interactions.withLock {
          if (event == Lifecycle.Event.ON_STOP) runtime()?.pauseTimers()
          else runtime()?.resumeTimers()
        }
      }
    }
  }
}

@Composable
private fun EmbeddedHostLifetime(
  owner: EmbeddedOwner,
  host: EmbeddedPrototypeHost,
  lifecycle: Lifecycle,
) {
  DisposableEffect(owner, host, lifecycle) {
    val observer =
      PrototypeTimerLifecycle.observer(host.scope, host.interactions) { owner.session?.runtime }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }
  // The host performs its own flush before reload and on stop, and closes on destroy. Only the
  // composition's temporary assets belong to this disposal path.
  DisposableEffect(owner) {
    onDispose {
      owner.session?.runtime?.close()
      host.flushScope.launch {
        withContext(NonCancellable) { host.interactions.withLock { owner.releaseAssets() } }
      }
    }
  }
}

@Composable
private fun EmbeddedLifetime(
  owner: EmbeddedOwner,
  lifecycle: Lifecycle,
  scope: CoroutineScope,
  interactions: Mutex,
) {
  DisposableEffect(owner, lifecycle) {
    val observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_START) {
        scope.launch { interactions.withLock { owner.session?.runtime?.resumeTimers() } }
      }
      if (event == Lifecycle.Event.ON_STOP) {
        scope.launch(NonCancellable, start = CoroutineStart.UNDISPATCHED) {
          interactions.withLock {
            owner.session?.runtime?.pauseTimers()
            owner.session?.runtime?.flushStorage()
          }
        }
      }
    }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }
  DisposableEffect(owner) {
    onDispose {
      owner.session?.runtime?.close()
      scope.launch(NonCancellable, start = CoroutineStart.UNDISPATCHED) {
        interactions.withLock { owner.close() }
      }
    }
  }
}

private class EmbeddedConfiguration(
  val spec: PrototypeSpec,
  val storage: PrototypeStorage,
  val network: PrototypeNetwork,
  val scope: CoroutineScope,
  val environment: EmbeddedPrototypeEnvironment,
  val cacheDir: java.io.File,
)

private class EmbeddedOwner(
  assets: PrototypeAssets,
  private val interactions: Mutex,
  private val io: CoroutineDispatcher,
) {
  var session by mutableStateOf<EmbeddedSession?>(null)
  var error by mutableStateOf<PrototypeLoadError?>(null)
  private val source = EmbeddedPrototypeAssets(assets)

  suspend fun open(config: EmbeddedConfiguration, event: suspend (PrototypeEvent) -> Unit) {
    if (config.environment.host?.isCurrent?.invoke() == false) return
    try {
      createSession(config, event)
    } catch (error: CancellationException) {
      throw error
    } catch (error: IOException) {
      Log.w("AutoMobilePrototype", "Cannot open prototype storage", error)
      this.error = PrototypeLoadError.Storage(error.message ?: "Storage unavailable")
    } catch (expectedStorageFailure: RuntimeException) {
      // App-owned storage and serialization can fail with arbitrary runtime exceptions.
      Log.w("AutoMobilePrototype", "Cannot open prototype storage", expectedStorageFailure)
      error = PrototypeLoadError.Storage(expectedStorageFailure.message ?: "Storage unavailable")
    }
  }

  private suspend fun createSession(
    config: EmbeddedConfiguration,
    event: suspend (PrototypeEvent) -> Unit,
  ) {
    val opened =
      PrototypeStoragePersistence(
          config.storage.adapt(),
          CoroutinePrototypeScheduler(config.scope),
          io,
          registry = config.environment.host?.storageRegistry,
        )
        .prepare(config.spec) {
          PrototypeSpecValidator.validate(Json.encodeToString(it)) is
            PrototypeSpecValidation.Success
        }
    opened.commit()
    withContext(io) { source.prepareFonts(opened.spec, config.cacheDir) }
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        opened.spec,
        sink = { event(it) },
        clock = config.environment.clock,
        nextSequence = {
          config.environment.host?.nextSequence?.invoke(opened.spec.id) ?: ++sequence
        },
        requestDismiss = config.environment.host?.requestDismiss ?: { true },
        storage = opened.session,
        httpClients = config.network.clients(),
        requestScope = config.scope,
        exclusively = { block -> interactions.withLock { block() } },
        newRequestId = config.environment.requestId,
      )
    config.environment.host?.onRuntime?.invoke(runtime)
    session =
      EmbeddedSession(
        runtime,
        PrototypeImageCache(source, BitmapPrototypeImageDecoder(), dispatcher = io),
        PrototypeFontCache(source, ComposePrototypeFontLoader()),
      )
  }

  suspend fun close() {
    try {
      session?.runtime?.flushStorage()
    } finally {
      session?.runtime?.close()
      releaseAssets()
    }
  }

  suspend fun releaseAssets() = withContext(io) { source.close() }
}
