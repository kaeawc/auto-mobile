package dev.jasonpearson.automobile.video.wrappers

import android.content.Context
import android.content.ContextWrapper
import android.hardware.display.VirtualDisplay
import android.view.Surface
import java.lang.reflect.Method

/**
 * Wraps the framework system Context so it reports shell's package name. The modern
 * `createVirtualDisplay` path validates that the Context's package is owned by the calling uid;
 * running under `app_process` the caller is shell (uid 2000), whose package is `com.android.shell`.
 */
private class ShellPackageContext(base: Context) : ContextWrapper(base) {
  override fun getPackageName(): String = "com.android.shell"

  override fun getOpPackageName(): String = "com.android.shell"
}

/**
 * Reflection wrapper for accessing hidden Android display APIs.
 *
 * This class provides access to `DisplayManagerGlobal.createVirtualDisplay()` with the
 * `displayIdToMirror` parameter, which is required for screen mirroring without MediaProjection.
 *
 * Only works when running as shell user (UID 2000) via `adb shell app_process`.
 */
object DisplayControl {

  private val displayManagerGlobalClass: Class<*> by lazy {
    Class.forName("android.hardware.display.DisplayManagerGlobal")
  }

  private val displayManagerGlobal: Any by lazy {
    val getInstanceMethod = displayManagerGlobalClass.getMethod("getInstance")
    getInstanceMethod.invoke(null)
      ?: throw IllegalStateException("DisplayManagerGlobal.getInstance() returned null")
  }

  private val legacyCreateVirtualDisplayMethod: Method? by lazy {
    // Pre-API-34 hidden signature: String name, int width, int height,
    // int densityDpi, Surface, int flags, VirtualDisplay.Callback, Handler,
    // String uniqueId, int displayIdToMirror.
    try {
      displayManagerGlobalClass.getMethod(
        "createVirtualDisplay",
        String::class.java,
        Int::class.javaPrimitiveType,
        Int::class.javaPrimitiveType,
        Int::class.javaPrimitiveType,
        Surface::class.java,
        Int::class.javaPrimitiveType,
        Class.forName("android.hardware.display.VirtualDisplay\$Callback"),
        android.os.Handler::class.java,
        String::class.java,
        Int::class.javaPrimitiveType,
      )
    } catch (_: NoSuchMethodException) {
      null
    }
  }

  private val virtualDisplayConfigBuilderClass: Class<*> by lazy {
    Class.forName("android.hardware.display.VirtualDisplayConfig\$Builder")
  }

  private val virtualDisplayConfigClass: Class<*> by lazy {
    Class.forName("android.hardware.display.VirtualDisplayConfig")
  }

  // API 34+ takes a VirtualDisplayConfig; the exact surrounding params vary by
  // release (Android 15 is Context, MediaProjection, VirtualDisplayConfig,
  // Callback, Executor), so resolve by scanning for the overload that accepts a
  // VirtualDisplayConfig rather than hard-coding a signature.
  private val configCreateVirtualDisplayMethod: Method by lazy {
    displayManagerGlobalClass.methods.firstOrNull { method ->
      method.name == "createVirtualDisplay" &&
        method.parameterTypes.any { it == virtualDisplayConfigClass }
    }
      ?: throw NoSuchMethodException(
        "No createVirtualDisplay overload accepts VirtualDisplayConfig"
      )
  }

  // `createVirtualDisplay` dereferences `context.getPackageName()`, so a null
  // Context is rejected. Inside `app_process` there is no Application, so obtain
  // the framework's system Context via ActivityThread (the standard shell-tool
  // bootstrap).
  private val systemContext: android.content.Context by lazy {
    val activityThreadClass = Class.forName("android.app.ActivityThread")
    val activityThread = activityThreadClass.getMethod("systemMain").invoke(null)
    val base =
      activityThreadClass.getMethod("getSystemContext").invoke(activityThread)
        as android.content.Context
    // DisplayManagerService rejects the call unless the Context's package is owned
    // by the calling uid ("packageName must match the calling uid"). The system
    // context reports "android"; wrap it so it reports shell's package instead.
    ShellPackageContext(base)
  }

  /** Get display information for the default display. */
  fun getDisplayInfo(displayId: Int = 0): DisplayInfo {
    val displayInfoClass = Class.forName("android.view.DisplayInfo")
    val displayInfo = displayInfoClass.getDeclaredConstructor().newInstance()

    // Android 15 (API 35) exposes `getDisplayInfo(int): DisplayInfo`; older
    // levels used the two-arg void form `getDisplayInfo(int, DisplayInfo)`.
    val resolvedInfo =
      try {
        val singleArg =
          displayManagerGlobalClass.getMethod("getDisplayInfo", Int::class.javaPrimitiveType)
        singleArg.invoke(displayManagerGlobal, displayId) ?: displayInfo
      } catch (_: NoSuchMethodException) {
        val twoArg =
          displayManagerGlobalClass.getMethod(
            "getDisplayInfo",
            Int::class.javaPrimitiveType,
            displayInfoClass,
          )
        twoArg.invoke(displayManagerGlobal, displayId, displayInfo)
        displayInfo
      }

    val logicalWidth = displayInfoClass.getField("logicalWidth").getInt(resolvedInfo)
    val logicalHeight = displayInfoClass.getField("logicalHeight").getInt(resolvedInfo)
    val logicalDensityDpi = displayInfoClass.getField("logicalDensityDpi").getInt(resolvedInfo)
    val rotation = displayInfoClass.getField("rotation").getInt(resolvedInfo)

    return DisplayInfo(
      width = logicalWidth,
      height = logicalHeight,
      densityDpi = logicalDensityDpi,
      rotation = rotation,
    )
  }

  /**
   * Register a framework callback that fires when the default display changes (issue #4785),
   * primarily to observe rotation. Returns a stop-lambda that unregisters the listener, or null
   * when registration is unavailable so the caller falls back to polling [getDisplayInfo].
   *
   * Under `app_process`/shell uid a real [android.hardware.display.DisplayManager] and a main
   * `Looper` may or may not be reachable; registration is best-effort and any failure degrades
   * cleanly to the poll fallback rather than aborting capture.
   *
   * @param onDisplayChanged invoked (on the framework Handler thread) whenever display 0 changes.
   * @return an unregister lambda on success, or null if no listener could be registered.
   */
  fun registerDisplayListener(onDisplayChanged: () -> Unit): (() -> Unit)? {
    return try {
      val displayManager =
        systemContext.getSystemService(android.hardware.display.DisplayManager::class.java)
          ?: return null
      val looper = android.os.Looper.getMainLooper() ?: return null
      val handler = android.os.Handler(looper)
      val listener =
        object : android.hardware.display.DisplayManager.DisplayListener {
          override fun onDisplayAdded(displayId: Int) = Unit

          override fun onDisplayRemoved(displayId: Int) = Unit

          override fun onDisplayChanged(displayId: Int) {
            if (displayId == DEFAULT_DISPLAY_ID) onDisplayChanged()
          }
        }
      displayManager.registerDisplayListener(listener, handler)
      return { displayManager.unregisterDisplayListener(listener) }
    } catch (error: Exception) {
      // Best-effort capability probe: under shell uid the DisplayManager or a usable Looper may be
      // unavailable. Swallow and return null so the poll fallback covers rotation detection.
      System.err.println("registerDisplayListener unavailable: ${error.message}")
      null
    }
  }

  private const val DEFAULT_DISPLAY_ID = 0

  /**
   * Create a VirtualDisplay that mirrors the specified display.
   *
   * @param name The name of the virtual display
   * @param width The width of the virtual display
   * @param height The height of the virtual display
   * @param densityDpi The density of the virtual display
   * @param surface The surface to render to
   * @param displayIdToMirror The display ID to mirror (typically 0 for the main display)
   * @return The created VirtualDisplay
   */
  fun createVirtualDisplay(
    name: String,
    width: Int,
    height: Int,
    densityDpi: Int,
    surface: Surface,
    displayIdToMirror: Int = 0,
  ): VirtualDisplay {
    // Flags for mirroring: VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR (1 << 4) = 16
    val flags = 1 shl 4

    legacyCreateVirtualDisplayMethod?.let { legacy ->
      return legacy.invoke(
        displayManagerGlobal,
        name,
        width,
        height,
        densityDpi,
        surface,
        flags,
        null, // callback
        null, // handler
        null, // uniqueId
        displayIdToMirror,
      ) as VirtualDisplay
    }

    // API 34+ path: build a VirtualDisplayConfig carrying the surface, flags, and
    // displayIdToMirror, then call the Context/MediaProjection/config overload
    // with null projection (shell uid mirrors without MediaProjection).
    val builder =
      virtualDisplayConfigBuilderClass
        .getConstructor(
          String::class.java,
          Int::class.javaPrimitiveType,
          Int::class.javaPrimitiveType,
          Int::class.javaPrimitiveType,
        )
        .newInstance(name, width, height, densityDpi)
    virtualDisplayConfigBuilderClass
      .getMethod("setFlags", Int::class.javaPrimitiveType)
      .invoke(builder, flags)
    virtualDisplayConfigBuilderClass
      .getMethod("setSurface", Surface::class.java)
      .invoke(builder, surface)
    virtualDisplayConfigBuilderClass
      .getMethod("setDisplayIdToMirror", Int::class.javaPrimitiveType)
      .invoke(builder, displayIdToMirror)
    val config = virtualDisplayConfigBuilderClass.getMethod("build").invoke(builder)

    return configCreateVirtualDisplayMethod.invoke(
      displayManagerGlobal,
      systemContext, // context (getPackageName() is dereferenced)
      null, // MediaProjection — shell uid mirrors without one
      config,
      null, // callback
      null, // Executor
    ) as VirtualDisplay
  }

  data class DisplayInfo(
    val width: Int,
    val height: Int,
    val densityDpi: Int,
    val rotation: Int,
  )
}
