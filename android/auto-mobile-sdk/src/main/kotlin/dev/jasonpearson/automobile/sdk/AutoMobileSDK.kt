package dev.jasonpearson.automobile.sdk

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.AnyThread
import androidx.annotation.RequiresPermission
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr
import dev.jasonpearson.automobile.sdk.biometrics.AutoMobileBiometrics
import dev.jasonpearson.automobile.sdk.breadcrumbs.Breadcrumb
import dev.jasonpearson.automobile.sdk.breadcrumbs.BreadcrumbCategory
import dev.jasonpearson.automobile.sdk.breadcrumbs.BreadcrumbTrail
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityDescriptor
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityDocument
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityRegistry
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import dev.jasonpearson.automobile.sdk.context.SdkContext
import dev.jasonpearson.automobile.sdk.context.SdkContextSnapshot
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.database.DatabaseInspector
import dev.jasonpearson.automobile.sdk.events.DefaultDropCounter
import dev.jasonpearson.automobile.sdk.events.DropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason
import dev.jasonpearson.automobile.sdk.events.SdkEventBroadcaster
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures
import dev.jasonpearson.automobile.sdk.interaction.AutoMobileClickTracker
import dev.jasonpearson.automobile.sdk.logging.AutoMobileLog
import dev.jasonpearson.automobile.sdk.logging.DefaultSdkLogger
import dev.jasonpearson.automobile.sdk.logging.SdkLogger
import dev.jasonpearson.automobile.sdk.network.AutoMobileNetwork
import dev.jasonpearson.automobile.sdk.network.NetworkMockRuleStore
import dev.jasonpearson.automobile.sdk.os.AutoMobileBroadcastInterceptor
import dev.jasonpearson.automobile.sdk.os.AutoMobileOsEvents
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence
import dev.jasonpearson.automobile.sdk.persistence.FileEventPersistence
import dev.jasonpearson.automobile.sdk.session.SessionTracker
import dev.jasonpearson.automobile.sdk.storage.DataStoreInspector
import dev.jasonpearson.automobile.sdk.storage.SharedPreferencesInspector
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Main SDK class for tracking navigation events across various Android navigation frameworks.
 *
 * This SDK provides a unified interface for hooking into navigation events whether you're using:
 * - XML-based Navigation Component
 * - Jetpack Compose Navigation
 * - Circuit navigation library
 * - Custom navigation solutions
 *
 * Usage:
 * ```kotlin
 * // Initialize the SDK with context (required for broadcasting)
 * AutoMobileSDK.initialize(applicationContext)
 *
 * // Register a listener
 * AutoMobileSDK.addNavigationListener { event ->
 *     println("Navigated to: ${event.destination}")
 * }
 *
 * // Emit navigation events from your framework adapter
 * AutoMobileSDK.notifyNavigationEvent(
 *     NavigationEvent(
 *         destination = "home",
 *         source = NavigationSource.COMPOSE_NAVIGATION
 *     )
 * )
 * ```
 */
object AutoMobileSDK {
  private const val TAG = "AutoMobileSDK"

  /**
   * Internal SDK logger. Replace with
   * [NoOpSdkLogger][dev.jasonpearson.automobile.sdk.logging.NoOpSdkLogger] to silence.
   */
  @Volatile internal var logger: SdkLogger = DefaultSdkLogger()

  private val listeners = CopyOnWriteArrayList<NavigationListener>()
  private val runtimeContextListeners = CopyOnWriteArrayList<RuntimeContextListener>()
  @Volatile private var _isEnabled = true
  @Volatile private var context: Context? = null
  @Volatile private var configuration: AutoMobileConfiguration? = null
  @Volatile private var eventBuffer: SdkEventBuffer? = null
  @Volatile private var persistence: EventPersistence? = null
  @Volatile private var mainHandler: Handler? = null
  @Volatile private var sessionTracker: SessionTracker? = null
  @Volatile private var sessionLifecycleObserver: DefaultLifecycleObserver? = null
  @Volatile private var sdkContext: SdkContext? = null
  @Volatile private var breadcrumbTrail: BreadcrumbTrail? = null
  @Volatile private var dropCounter: DropCounter? = null
  private val capabilityRegistry = SdkCapabilityRegistry()
  private val lifecycleLock = Any()
  @Volatile private var navigationOnlyMode = false
  private var mainThreadTeardownPending = false
  private var pendingInitialization: (() -> Unit)? = null

  const val ACTION_NAVIGATION_EVENT = "dev.jasonpearson.automobile.sdk.NAVIGATION_EVENT"
  const val EXTRA_DESTINATION = "destination"
  const val EXTRA_SOURCE = "source"
  const val EXTRA_TIMESTAMP = "timestamp"
  const val EXTRA_APPLICATION_ID = "application_id"
  const val ACTION_RECOMPOSITION_CONTROL = "dev.jasonpearson.automobile.sdk.RECOMPOSITION_CONTROL"
  const val ACTION_RECOMPOSITION_SNAPSHOT = "dev.jasonpearson.automobile.sdk.RECOMPOSITION_SNAPSHOT"
  const val EXTRA_RECOMPOSITION_ENABLED = "enabled"
  const val EXTRA_RECOMPOSITION_SNAPSHOT = "snapshot_json"
  const val ACTION_FRAME_METRICS_CONTROL = "dev.jasonpearson.automobile.sdk.FRAME_METRICS_CONTROL"
  const val ACTION_FRAME_METRICS_SNAPSHOT = "dev.jasonpearson.automobile.sdk.FRAME_METRICS_SNAPSHOT"
  const val EXTRA_FRAME_METRICS_ENABLED = "frame_metrics_enabled"
  const val EXTRA_FRAME_METRICS_SNAPSHOT = "frame_metrics_snapshot_json"

  /**
   * Initialize the SDK with application context. Required for broadcasting navigation events across
   * processes.
   *
   * @param context Application context (use applicationContext, not activity context)
   */
  @RequiresPermission(android.Manifest.permission.ACCESS_NETWORK_STATE)
  fun initialize(context: Context) {
    initialize(context, AutoMobileConfiguration.Builder().build())
  }

  /**
   * Initialize the SDK with application context and custom configuration.
   *
   * @param context Application context (use applicationContext, not activity context)
   * @param configuration SDK configuration built via [AutoMobileConfiguration.Builder]
   */
  @RequiresPermission(android.Manifest.permission.ACCESS_NETWORK_STATE)
  fun initialize(context: Context, configuration: AutoMobileConfiguration) {
    synchronized(lifecycleLock) {
      if (mainThreadTeardownPending) {
        val appContext = context.applicationContext
        pendingInitialization = { initialize(appContext, configuration) }
        return
      }
      try {
        if (this.context != null || navigationOnlyMode) {
          logger.d(TAG) { "AutoMobileSDK already initialized" }
          return
        }

        navigationOnlyMode = false
        this.context = context.applicationContext
        this.configuration = configuration
        capabilityRegistry.markInitialized()
        AutoMobileNetwork.setCapturePolicyProvider { capabilityRegistry.currentPolicy() }
        AutoMobileNetwork.setNetworkControlProvider {
          capabilityRegistry.isCapabilitySupported("network.control")
        }
        val appContext = this.context!!

        // Create disk persistence for events
        val eventPersistence = FileEventPersistence(File(appContext.cacheDir, "automobile_events"))
        persistence = eventPersistence

        // Create drop counter for tracking event drops across the pipeline
        val counter = DefaultDropCounter()
        dropCounter = counter
        SdkEventBroadcaster.dropCounter = counter

        // Create shared event buffer with broadcast flush callback and disk persistence
        val buffer =
          SdkEventBuffer(
            maxBufferSize = configuration.bufferSize,
            flushIntervalMs = configuration.flushIntervalMs,
            onFlush = { events -> SdkEventBroadcaster.broadcastBatch(appContext, events) },
            persistence = eventPersistence,
            dropCounter = counter,
            processors = configuration.eventProcessors,
            maxPendingEvents = configuration.maxPendingEvents,
            backPressureStrategy = configuration.backPressureStrategy,
          )
        buffer.isEnabled = _isEnabled
        buffer.start()
        eventBuffer = buffer

        // Initialize SDK context with app version from PackageManager
        val ctx = SdkContext()
        try {
          ctx.appVersion =
            appContext.packageManager.getPackageInfo(appContext.packageName, 0).versionName
        } catch (_: Exception) {
          // PackageManager lookup may fail in test environments
        }
        sdkContext = ctx
        // Replay pending batches and clean up old ones on the buffer's executor
        // to avoid blocking the calling thread with disk I/O.
        buffer.execute {
          replayPendingBatches(appContext, eventPersistence)
          eventPersistence.cleanup()
        }

        // Thread-safe subsystems — can initialize from any thread
        NetworkMockRuleStore.initialize(appContext)
        AutoMobileNetwork.initialize(
          appContext.packageName,
          buffer,
          NetworkMockRuleStore.getInstance().ruleMatcher,
        )
        AutoMobileLog.initialize()
        AutoMobileBroadcastInterceptor.initialize(appContext, buffer)

        DatabaseInspector.initialize(appContext)
        SharedPreferencesInspector.initialize(appContext)
        AutoMobileFailures.initialize(appContext)

        AutoMobileCrashes.initialize(appContext)
        val trail = BreadcrumbTrail()
        breadcrumbTrail = trail
        AutoMobileCrashes.breadcrumbTrail = trail

        AutoMobileAnr.initialize(appContext)
        AutoMobileBiometrics.initialize(appContext)

        val tracker = SessionTracker()
        sessionTracker = tracker

        // Subsystems that register lifecycle observers or activity callbacks must run on main
        // thread
        val handler = Handler(Looper.getMainLooper())
        mainHandler = handler
        handler.post {
          try {
            // Guard: if shutdown() was called before this posted block runs, no-op.
            if (this@AutoMobileSDK.context == null) return@post
            AutoMobileOsEvents.initialize(appContext, buffer) { kind ->
              notifyRuntimeContextChanged(kind)
            }

            // Register session tracker with process lifecycle
            val observer =
              object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                  tracker.onForeground()
                }

                override fun onStop(owner: LifecycleOwner) {
                  tracker.onBackground()
                }
              }
            sessionLifecycleObserver = observer
            ProcessLifecycleOwner.get().lifecycle.addObserver(observer)
            capabilityRegistry.markLifecycleReady()
            RecompositionTracker.initialize(appContext)
            RecompositionTracker.setEnabled(_isEnabled)
            FrameMetricsCollector.initialize(appContext)
            FrameMetricsCollector.setEnabled(_isEnabled)
            AutoMobileNotifications.initialize(appContext)
            if (appContext is Application) {
              AutoMobileClickTracker.initialize(appContext, appContext.packageName)
            }
          } catch (error: Exception) {
            logger.e(TAG, error) { "AutoMobileSDK main-thread initialization failed; rolling back" }
            shutdown()
          }
        }
      } catch (error: Exception) {
        shutdown()
        throw error
      }
    }
  }

  /**
   * Initializes navigation event delivery without activating the broad SDK integrations.
   *
   * This mode does not initialize SDK inspection, diagnostics, network, interaction, or performance
   * subsystems. Calling it while either SDK mode is active is a no-op; call [shutdown] before
   * switching modes.
   */
  fun initialize(configuration: NavigationConfiguration) {
    synchronized(lifecycleLock) {
      if (mainThreadTeardownPending) {
        pendingInitialization = { initialize(configuration) }
        return
      }
      if (context != null || navigationOnlyMode) {
        logger.d(TAG) { "AutoMobileSDK already initialized" }
        return
      }

      initializeNavigationOnly(configuration)
    }
  }

  private fun initializeNavigationOnly(configuration: NavigationConfiguration) {
    try {
      navigationOnlyMode = true
      val appContext = configuration.context.applicationContext
      context = appContext
      capabilityRegistry.markNavigationInitialized()

      val counter = DefaultDropCounter()
      dropCounter = counter
      SdkEventBroadcaster.dropCounter = counter

      eventBuffer =
        SdkEventBuffer(
            onFlush = { events -> SdkEventBroadcaster.broadcastBatch(appContext, events) },
            dropCounter = counter,
          )
          .also {
            it.isEnabled = _isEnabled
            it.start()
          }
    } catch (error: Exception) {
      logger.e(TAG, error) {
        "Navigation-only initialization failed; disabling navigation delivery"
      }
      shutdown()
    }
  }

  /**
   * Adds a navigation listener to receive navigation events.
   *
   * @param listener The listener to add
   */
  @AnyThread
  fun addNavigationListener(listener: NavigationListener) {
    listeners.add(listener)
  }

  /**
   * Removes a previously added navigation listener.
   *
   * @param listener The listener to remove
   */
  @AnyThread
  fun removeNavigationListener(listener: NavigationListener) {
    listeners.remove(listener)
  }

  /** Registers a removable listener for lifecycle and host-context changes. */
  fun addRuntimeContextListener(listener: RuntimeContextListener) {
    runtimeContextListeners.add(listener)
  }

  /** Removes a previously registered runtime-context listener. */
  fun removeRuntimeContextListener(listener: RuntimeContextListener) {
    runtimeContextListeners.remove(listener)
  }

  /** Removes all navigation listeners. */
  fun clearNavigationListeners() {
    listeners.clear()
  }

  /**
   * Notifies all registered listeners of a navigation event. This method is typically called by
   * framework adapters. Events are routed through the shared event buffer for async delivery.
   *
   * @param event The navigation event to emit
   */
  @AnyThread
  fun notifyNavigationEvent(event: NavigationEvent) {
    if (!_isEnabled) return

    // Notify in-process listeners
    listeners.forEach { listener ->
      try {
        listener.onNavigationEvent(event)
      } catch (e: Exception) {
        // Catch exceptions to prevent one listener from breaking others
        logger.e(TAG, e) { "Listener threw" }
      }
    }

    // Route navigation events through the shared event buffer so they are
    // batched and broadcast on the buffer's background thread instead of
    // blocking the caller (which is often the main thread).
    try {
      addBreadcrumb(event.destination, BreadcrumbCategory.NAVIGATION, event.metadata)
      val buf = eventBuffer ?: return
      val ctx = context ?: return
      buf.add(
        SdkNavigationEvent(
          timestamp = System.currentTimeMillis(),
          applicationId = ctx.packageName,
          destination = event.destination,
          source = event.source.toProtocolType(),
          arguments = event.arguments.mapValues { it.value?.toString() ?: "null" },
          metadata = event.metadata,
        )
      )
    } catch (error: Exception) {
      logger.e(TAG, error) { "Failed to dispatch navigation event" }
    }
  }

  /** Convert SDK NavigationSource to protocol NavigationSourceType. */
  private fun NavigationSource.toProtocolType(): NavigationSourceType {
    return when (this) {
      NavigationSource.NAVIGATION_COMPONENT -> NavigationSourceType.NAVIGATION_COMPONENT
      NavigationSource.COMPOSE_NAVIGATION -> NavigationSourceType.COMPOSE_NAVIGATION
      NavigationSource.CIRCUIT -> NavigationSourceType.CIRCUIT
      NavigationSource.CUSTOM -> NavigationSourceType.CUSTOM
      NavigationSource.DEEP_LINK -> NavigationSourceType.DEEP_LINK
      NavigationSource.ACTIVITY -> NavigationSourceType.ACTIVITY
    }
  }

  /**
   * Enables or disables capture and tracking while leaving installed runtime hooks in place.
   *
   * Call [shutdown] to detach all hooks and return the SDK to its pre-initialization state.
   *
   * @param enabled Whether event capture and tracking should be enabled
   */
  fun setEnabled(enabled: Boolean) {
    _isEnabled = enabled
    eventBuffer?.isEnabled = enabled
    if (context != null && !navigationOnlyMode) {
      RecompositionTracker.setEnabled(enabled)
      FrameMetricsCollector.setEnabled(enabled)
      capabilityRegistry.setEnabled(enabled)
    }
  }

  /** Returns the versioned capability and policy snapshot for this SDK integration. */
  val capabilities: SdkCapabilityDocument
    get() = capabilityRegistry.snapshot()

  /** Registers or replaces an optional host-provided capability. */
  fun registerCapability(descriptor: SdkCapabilityDescriptor) {
    capabilityRegistry.register(descriptor)
  }

  /** Returns whether a capability is currently supported and usable. */
  internal fun isCapabilitySupported(id: String): Boolean =
    capabilityRegistry.isCapabilitySupported(id)

  /** Removes an optional host-provided capability. */
  fun unregisterCapability(id: String) {
    capabilityRegistry.unregister(id)
  }

  /** Atomically replaces the capture and mutation policy after capability validation. */
  fun updateCapturePolicy(policy: SdkCapturePolicy) {
    capabilityRegistry.updatePolicy(policy)
  }

  /** Whether navigation tracking is currently enabled. */
  val isTrackingEnabled: Boolean
    get() = _isEnabled

  /** The current number of registered listeners. */
  val listenerCount: Int
    get() = listeners.size

  /** Returns the current session ID, or null if no active session. */
  fun currentSessionId(): String? = sessionTracker?.currentSessionId()

  /**
   * Add a breadcrumb to the trail. Breadcrumbs are attached to crash reports so that recent app
   * activity is visible when diagnosing crashes.
   *
   * @param message A short description of the breadcrumb
   * @param category The category (defaults to CUSTOM)
   * @param metadata Optional key-value metadata
   */
  fun addBreadcrumb(
    message: String,
    category: BreadcrumbCategory = BreadcrumbCategory.CUSTOM,
    metadata: Map<String, String> = emptyMap(),
  ) {
    breadcrumbTrail?.add(
      Breadcrumb(
        timestamp = System.currentTimeMillis(),
        category = category,
        message = message,
        metadata = metadata,
      )
    )
  }

  /** Sets the current screen or route used by future diagnostics and lifecycle events. */
  fun setCurrentScreen(screen: String?) {
    sdkContext?.currentScreen = screen?.take(MAX_CONTEXT_VALUE_LENGTH)
    if (context != null && !navigationOnlyMode) {
      AutoMobileCrashes.currentScreenProvider = { sdkContext?.snapshot()?.currentScreen }
    }
    notifyRuntimeContextChanged(if (screen == null) "screen_cleared" else "screen_changed")
  }

  /** Sets the current tenant or workspace identifier used by future diagnostics. */
  fun setTenantId(tenantId: String?) {
    sdkContext?.tenantId = tenantId?.take(MAX_CONTEXT_VALUE_LENGTH)
    notifyRuntimeContextChanged(if (tenantId == null) "tenant_cleared" else "tenant_changed")
  }

  /** Records a bounded, schema-versioned application event. */
  fun recordCustomEvent(
    name: String,
    schemaVersion: String = "1",
    fields: Map<String, String> = emptyMap(),
  ) {
    if (!_isEnabled || name.isBlank() || context == null || navigationOnlyMode) return
    val buf = eventBuffer ?: return
    val ctx = context ?: return
    val snapshot = sdkContext?.snapshot()
    val details = buildMap {
      fields.entries.take(MAX_CUSTOM_EVENT_FIELDS).forEach { (key, value) ->
        put(key.take(MAX_CONTEXT_KEY_LENGTH), value.take(MAX_CONTEXT_VALUE_LENGTH))
      }
      put("name", name.take(MAX_CONTEXT_VALUE_LENGTH))
      put("schema_version", schemaVersion.take(MAX_CONTEXT_VALUE_LENGTH))
      snapshot?.tenantId?.let { put("tenant_id", it) }
      snapshot?.currentScreen?.let { put("current_screen", it) }
    }
    buf.add(
      SdkLifecycleEvent(
        timestamp = System.currentTimeMillis(),
        applicationId = ctx.packageName,
        kind = "custom_event",
        details = details,
      )
    )
    addBreadcrumb(name, BreadcrumbCategory.CUSTOM, details)
  }

  /**
   * A snapshot of drop counts by reason.
   *
   * Useful for diagnostics — the map is empty when no events have been dropped.
   */
  val dropReport: Map<DropReason, Long>
    get() = dropCounter?.snapshot() ?: emptyMap()

  /** Returns the shared event buffer, or null if not initialized. */
  internal fun getEventBuffer(): SdkEventBuffer? = eventBuffer

  /** Sets the user identifier on the SDK context. */
  fun setUserId(userId: String?) {
    sdkContext?.userId = userId?.take(MAX_CONTEXT_VALUE_LENGTH)
    notifyRuntimeContextChanged(if (userId == null) "user_cleared" else "user_changed")
  }

  /** Sets a tag on the SDK context. */
  fun setTag(key: String, value: String) {
    if (key.isBlank()) return
    sdkContext?.setTag(key.take(MAX_CONTEXT_KEY_LENGTH), value.take(MAX_CONTEXT_VALUE_LENGTH))
    notifyRuntimeContextChanged("tag_changed")
  }

  /** Removes a tag from the SDK context. */
  fun removeTag(key: String) {
    sdkContext?.removeTag(key)
    notifyRuntimeContextChanged("tag_removed")
  }

  /** An immutable snapshot of the current SDK context, or null if not initialized. */
  val contextSnapshot: SdkContextSnapshot?
    get() = sdkContext?.snapshot()

  private fun notifyRuntimeContextChanged(kind: String) {
    if (!_isEnabled) return
    val snapshot = sdkContext?.snapshot() ?: return
    runtimeContextListeners.forEach { listener ->
      runCatching { listener.onRuntimeContextChanged(kind, snapshot) }
    }
  }

  /**
   * Replay pending event batches from disk (events that survived process death). Each batch is
   * broadcast and removed on success; failures remain on disk.
   */
  private fun replayPendingBatches(context: Context, persistence: EventPersistence) {
    for ((batchId, events) in persistence.loadPending()) {
      try {
        SdkEventBroadcaster.broadcastBatch(context, events)
        persistence.removeBatch(batchId)
      } catch (_: Exception) {
        // Keep on disk for next launch attempt
      }
    }
  }

  /**
   * Shuts down the SDK, releasing all resources. After calling this method, [initialize] may be
   * called again to restart the SDK.
   */
  fun shutdown() {
    synchronized(lifecycleLock) {
      if (navigationOnlyMode) {
        shutdownNavigationOnly()
        return
      }

      pendingInitialization = null
      // Cancel any pending main-thread init work so a fast init→shutdown
      // sequence doesn't re-register hooks after shutdown completes.
      mainHandler?.removeCallbacksAndMessages(null)
      mainHandler = null

      // Tear down subsystem hooks. Lifecycle observer removal and click
      // tracker unregistration must happen on the main thread.
      // Read sessionLifecycleObserver inside the Runnable so we see the
      // value assigned by a concurrent init handler, not a stale snapshot.
      val ctx = context
      if (ctx != null) {
        val teardown = Runnable {
          AutoMobileOsEvents.shutdown(ctx)
          AutoMobileBroadcastInterceptor.shutdown(ctx)
          AutoMobileClickTracker.shutdown(ctx)
          NetworkMockRuleStore.shutdown(ctx)
          sessionLifecycleObserver?.let {
            ProcessLifecycleOwner.get().lifecycle.removeObserver(it)
          }
          sessionLifecycleObserver = null
          completeMainThreadTeardown()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
          teardown.run()
        } else {
          mainThreadTeardownPending = true
          Handler(Looper.getMainLooper()).post(teardown)
        }
      }

      // Clear application-provided DataStore adapters so shutdown does not retain host references
      // (issue #5192).
      DataStoreInspector.reset()
      DatabaseInspector.reset()
      SharedPreferencesInspector.reset()
      AutoMobileCrashes.uninstall()
      AutoMobileAnr.reset()
      AutoMobileBiometrics.shutdown()
      AutoMobileFailures.reset()
      AutoMobileNotifications.reset()

      sessionTracker?.shutdown()
      sessionTracker = null

      eventBuffer?.shutdown()
      eventBuffer = null
      sdkContext?.reset()
      sdkContext = null
      breadcrumbTrail?.clear()
      breadcrumbTrail = null
      dropCounter = null
      SdkEventBroadcaster.reset()
      persistence = null
      RecompositionTracker.reset()
      FrameMetricsCollector.reset()
      listeners.clear()
      runtimeContextListeners.clear()
      _isEnabled = true
      AutoMobileNetwork.setCapturePolicyProvider(null)
      AutoMobileNetwork.setNetworkControlProvider(null)
      AutoMobileNetwork.reset()
      capabilityRegistry.markShutdown()
      configuration = null
      context = null
      navigationOnlyMode = false
    }
  }

  private fun shutdownNavigationOnly() {
    eventBuffer?.shutdown()
    eventBuffer = null
    dropCounter = null
    SdkEventBroadcaster.reset()
    listeners.clear()
    runtimeContextListeners.clear()
    _isEnabled = true
    capabilityRegistry.markNavigationShutdown()
    context = null
    navigationOnlyMode = false
  }

  private fun completeMainThreadTeardown() {
    synchronized(lifecycleLock) {
      mainThreadTeardownPending = false
      val nextInitialization = pendingInitialization ?: return
      pendingInitialization = null
      nextInitialization()
    }
  }

  /** Returns the current configuration, or null if not initialized. */
  internal fun getConfiguration(): AutoMobileConfiguration? = configuration

  private const val MAX_CONTEXT_KEY_LENGTH = 64
  private const val MAX_CONTEXT_VALUE_LENGTH = 256
  private const val MAX_CUSTOM_EVENT_FIELDS = 32
}
