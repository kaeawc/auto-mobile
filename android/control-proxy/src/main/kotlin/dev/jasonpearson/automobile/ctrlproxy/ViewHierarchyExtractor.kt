package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Build
import android.text.Spanned
import android.text.style.ClickableSpan
import android.util.Log
import android.util.SparseArray
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.core.util.size
import dev.jasonpearson.automobile.ctrlproxy.models.ContentHiddenRegion
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SemanticLink
import dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.models.WindowInfo
import dev.jasonpearson.automobile.ctrlproxy.prototype.DEFAULT_CTRL_PROXY_PACKAGE
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowMetadata
import dev.jasonpearson.automobile.ctrlproxy.prototype.hasPrototypeTitle
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeIdOfTitle
import dev.jasonpearson.automobile.protocol.PrototypeHiddenReason
import kotlin.math.max
import kotlin.math.min

/**
 * Component responsible for parsing AccessibilityNodeInfo trees and converting them into
 * UIElementInfo objects for automated testing.
 */
class ViewHierarchyExtractor
// Keep the independent, default-off debug flag injectable without regrouping existing callbacks.
@Suppress("LongParameterList")
internal constructor(
  private val recompositionStore: RecompositionStore? = null,
  internal val stats: CtrlProxyWorkStats = CtrlProxyWorkStats(),
  internal val logOptimizationDecisions: Boolean = false,
  /**
   * Metadata for CtrlProxy's own prototype window, asked per captured window that carries the
   * prototype's type and title (either layer) with the window's root package and title; null for
   * any other window or when none is showing.
   */
  private val ownPrototypeMetadata:
    (windowPackage: String?, title: CharSequence?) -> PrototypeWindowMetadata? =
    { _, _ ->
      null
    },
  /** Whether a prototype is hidden because its app left the foreground (#10261). */
  private val prototypeSuspended: () -> Boolean = { false },
  private val prototypeHiddenReason:
    (displayId: Int, ownPrototypeWindowCaptured: Boolean?) -> PrototypeHiddenReason? =
    { _, _ ->
      null
    },
  private val pruneBaselineWrappers: Boolean = false,
) {

  internal data class DisplayWindows(val displayId: Int, val windows: List<AccessibilityWindowInfo>)

  internal fun selectDisplayWindows(
    service: AccessibilityService,
    requestedDisplayId: Int? = null,
  ): DisplayWindows {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      val id = requestedDisplayId ?: Display.DEFAULT_DISPLAY
      return DisplayWindows(id, windowsForDisplay(service, id))
    }
    val all = service.windowsOnAllDisplays
    val id = targetDisplayId(all, requestedDisplayId)
    return DisplayWindows(id, windowsForDisplay(all, id))
  }

  /** The framework's all-display map is available from Android R onward. */
  internal fun windowsForDisplay(
    service: AccessibilityService,
    displayId: Int,
  ): List<AccessibilityWindowInfo> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return if (displayId == Display.DEFAULT_DISPLAY) service.windows.orEmpty() else emptyList()
    }
    return windowsForDisplay(service.windowsOnAllDisplays, displayId)
  }

  internal fun windowsForDisplay(
    windowsByDisplay: SparseArray<List<AccessibilityWindowInfo>>,
    displayId: Int,
  ): List<AccessibilityWindowInfo> {
    val selected = windowsByDisplay[displayId].orEmpty()
    if (displayId != Display.DEFAULT_DISPLAY || selected.none { it.isFocused || it.isActive }) {
      return selected
    }
    val overlays =
      (0 until windowsByDisplay.size).flatMap { index ->
        windowsByDisplay.valueAt(index).filter { window ->
          window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD ||
            window.root?.let { root ->
              try {
                root.packageName?.toString() == "com.android.systemui"
              } finally {
                root.recycle()
              }
            } == true
        }
      }
    return (selected + overlays).distinctBy { it.id }
  }

  internal fun targetDisplayId(
    windowsByDisplay: SparseArray<List<AccessibilityWindowInfo>>,
    requestedDisplayId: Int? = null,
  ): Int {
    requestedDisplayId?.let {
      return it
    }
    if (windowsByDisplay[Display.DEFAULT_DISPLAY].orEmpty().any { it.isFocused || it.isActive }) {
      return Display.DEFAULT_DISPLAY
    }
    for (index in 0 until windowsByDisplay.size) {
      if (windowsByDisplay.valueAt(index).any { it.isFocused }) return windowsByDisplay.keyAt(index)
    }
    for (index in 0 until windowsByDisplay.size) {
      if (windowsByDisplay.valueAt(index).any { it.isActive }) return windowsByDisplay.keyAt(index)
    }
    return Display.DEFAULT_DISPLAY
  }

  internal fun rootForDisplay(
    activeRoot: AccessibilityNodeInfo?,
    windows: List<AccessibilityWindowInfo>,
    displayId: Int,
  ): AccessibilityNodeInfo? {
    val rootWindow = activeRoot?.window
    val belongsToTarget =
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && rootWindow?.displayId == displayId) ||
        windows.any {
          it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.id == activeRoot?.windowId
        } ||
        (displayId == Display.DEFAULT_DISPLAY && windows.isEmpty() && rootWindow == null)
    if (belongsToTarget) return activeRoot
    return windows
      .firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isFocused }
      ?.root
      ?: windows
        .firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isActive }
        ?.root
      ?: windows.firstOrNull { it.isFocused || it.isActive }?.root
  }

  companion object {
    private const val TAG = "ViewHierarchyExtractor"
    private const val MAX_DEPTH = 100 // Prevent infinite traversal in focus-order extraction
    private const val MAX_CHILDREN = 256 // Limit children to prevent memory issues
    private const val DEFAULT_WINDOW_KEY = -1
    private const val INCOMPLETE_ACTIVE_WINDOW_NULL_ROOT = "active_window_null_root"
    private const val INCOMPLETE_APP_WINDOW_NULL_ROOT = "app_window_null_root"
    private const val INCOMPLETE_NO_APP_WINDOW_ROOT = "no_app_window_root"
    private const val CONTENT_HIDDEN_REASON_COMPOSE_INTEROP = "compose-interop-no-hide-descendants"
    private const val MIN_HIDDEN_REGION_SCREEN_AREA = 0.25
    private const val MAX_VISIBLE_CHILD_COVERAGE = 0.25
    // Android encodes the user ID in the upper portion of every process UID.
    // UserHandle's corresponding helpers are hidden APIs, unavailable to apps.
    private const val ANDROID_USER_ID_RANGE = 100_000

    // androidx AccessibilityNodeInfoCompat stashes the state description in the node's extras
    // bundle under this key on API < 30, where the direct getter is unavailable. Compose relies
    // on this shim to expose toggleable/selectable state (issue #3139).
    private const val STATE_DESCRIPTION_EXTRA_KEY =
      "androidx.view.accessibility.AccessibilityNodeInfoCompat.STATE_DESCRIPTION_KEY"

    private val GENERIC_CLASS_NAMES =
      setOf(
        "android.view.View",
        "android.widget.FrameLayout",
        "android.widget.ScrollView",
        "android.widget.TextView",
      )
  }

  /**
   * Extracts view hierarchy from the active window.
   *
   * @param rootNode Root accessibility node
   * @param options Filtering, snapshot budget, and display attribution for this capture
   */
  @JvmOverloads
  fun extractFromActiveWindow(
    rootNode: AccessibilityNodeInfo?,
    options: HierarchyExtractionOptions = HierarchyExtractionOptions(),
  ): ViewHierarchy? =
    with(options) {
      if (rootNode == null) {
        Log.w(TAG, "Root node is null")
        return@with ViewHierarchy(error = "Root node is null")
      }

      var accessibilityFocusedNode: AccessibilityNodeInfo? = null
      return@with try {
        // Find accessibility-focused node before extracting hierarchy
        accessibilityFocusedNode = rootNode.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
        ActiveWindowCapture(rootNode, accessibilityFocusedNode, options).capture()
      } catch (e: IllegalArgumentException) {
        Log.e(TAG, "Error extracting view hierarchy", e)
        ViewHierarchy(error = "Failed to extract view hierarchy: ${e.message}")
      } catch (e: IllegalStateException) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        Log.e(TAG, "Error extracting view hierarchy", e)
        ViewHierarchy(error = "Failed to extract view hierarchy: ${e.message}")
      } catch (e: SecurityException) {
        Log.e(TAG, "Error extracting view hierarchy", e)
        ViewHierarchy(error = "Failed to extract view hierarchy: ${e.message}")
      } finally {
        accessibilityFocusedNode?.recycle()
      }
    }

  private inner class ActiveWindowCapture(
    val rootNode: AccessibilityNodeInfo,
    val accessibilityFocusedNode: AccessibilityNodeInfo?,
    val options: HierarchyExtractionOptions,
  ) {
    private val budget = HierarchySnapshotBudget(options.snapshotOptions)

    fun capture(): ViewHierarchy? =
      with(options) {
        val rootElement =
          extractNodeInfo(
            rootNode,
            0,
            NodeExtraction(
              textFilter,
              screenDimensions,
              dedupeTextContentDesc,
              accessibilityFocusedNode,
              budget,
            ),
          )
        val contentHiddenRegions = rootElement?.let {
          detectContentHiddenRegions(listOf(it), screenDimensions)
        }

        // Skip optimization and filtering if disableAllFiltering is true
        val processedElement =
          if (disableAllFiltering) {
            rootElement
          } else {
            val optimizedList = rootElement?.let { optimizeHierarchy(it) }
            Log.d(TAG, "[PROCESS] After optimizeHierarchy: ${optimizedList?.size} elements")

            val wrappedElement = optimizedList?.let { wrapOptimizedElements(it) }

            // Single-window occlusion filtering is intentionally skipped.
            // After optimizeHierarchy promotes children from bounds-only wrappers, the tree
            // structure no longer matches visual relationships, causing false occlusion between
            // visual siblings that end up at different tree depths (e.g., Compose overlapping
            // layouts).
            wrappedElement
          }

        result(processedElement, contentHiddenRegions)
      }

    private fun result(
      processedElement: UIElementInfo?,
      contentHiddenRegions: List<ContentHiddenRegion>?,
    ): ViewHierarchy =
      with(options) {
        val intentChooserDetected =
          processedElement?.let { detectIntentChooserIndicators(it) } ?: false
        val notificationPermissionDetected = processedElement?.let {
          detectNotificationPermissionDialog(it, rootNode.packageName?.toString())
        }

        val unifiedHierarchy = processedElement?.let {
          UIElementInfo(
            children = listOf(it.copy(displayId = displayId, panelUniqueId = panelUniqueId)),
          )
        }

        // Find the accessibility-focused element in the unified hierarchy
        val accessibilityFocusedElement = unifiedHierarchy?.let {
          findAccessibilityFocusedElement(it)
        }

        return@with ViewHierarchy(
          packageName = rootNode.packageName?.toString(),
          userId = android.os.Process.myUid() / ANDROID_USER_ID_RANGE,
          hierarchy = unifiedHierarchy?.let { WireNodeCodec.materialize(it) },
          intentChooserDetected = intentChooserDetected,
          notificationPermissionDetected = notificationPermissionDetected,
          accessibilityFocusedElement =
            accessibilityFocusedElement?.let { WireNodeCodec.materialize(it) },
          contentHiddenRegions = contentHiddenRegions?.takeIf { it.isNotEmpty() },
          truncationReasons = budget.truncationReasons().ifEmpty { null },
          prototypeSuspended = prototypeSuspended().takeIf { it },
          prototypeHiddenReason = prototypeHiddenReason(displayId ?: Display.DEFAULT_DISPLAY, null),
        )
      }
  }

  /**
   * Extracts view hierarchy from all visible windows. This captures popups, toolbars, and other
   * floating windows that aren't in the main window.
   *
   * @param windows List of all accessibility windows (from AccessibilityService.windows)
   * @param activeWindowRoot Root node of the active window (for backward compatibility)
   * @param options Filtering, cross-window occlusion, snapshot budget, and display attribution
   */
  @JvmOverloads
  fun extractFromAllWindows(
    windows: List<AccessibilityWindowInfo>,
    activeWindowRoot: AccessibilityNodeInfo?,
    options: HierarchyExtractionOptions = HierarchyExtractionOptions(),
  ): ViewHierarchy =
    with(options) {
      if (windows.isEmpty() && activeWindowRoot == null) {
        Log.w(TAG, "No windows available for extraction")
        return@with ViewHierarchy(error = "No windows available")
      }

      val accessibilityFocusedNode = findAccessibilityFocus(windows, activeWindowRoot)

      try {
        return@with WindowCapture(windows, activeWindowRoot, accessibilityFocusedNode, options)
          .capture()
      } finally {
        accessibilityFocusedNode?.recycle()
      }
    }

  private data class CapturedWindow(
    val root: AccessibilityNodeInfo,
    val bounds: Rect,
    val type: String,
    val layer: Int,
  )

  private inner class WindowCapture(
    val windows: List<AccessibilityWindowInfo>,
    val activeWindowRoot: AccessibilityNodeInfo?,
    val accessibilityFocusedNode: AccessibilityNodeInfo?,
    val options: HierarchyExtractionOptions,
  ) {
    private val textFilter
      get() = options.textFilter

    private val screenDimensions
      get() = options.screenDimensions

    private val dedupeTextContentDesc
      get() = options.dedupeTextContentDesc

    private val disableAllFiltering
      get() = options.disableAllFiltering

    private val occlusionEnabled
      get() = options.occlusionEnabled

    private val snapshotOptions
      get() = options.snapshotOptions

    private val displayId
      get() = options.displayId

    private val panelUniqueId
      get() = options.panelUniqueId

    val windowEntries = mutableListOf<WindowEntry>()
    var ownPrototypeWindowCaptured = false
    var prototypeRootUnreadable = false
    val primaryAppWindowId: Int? = pickPrimaryAppWindowId(windows)
    // Preserve the full legacy allowance for a lone primary window. Reserving a second slot
    // would truncate it sooner even when fallback is never needed.
    val reserveFallback =
      activeWindowRoot != null && (windows.size != 1 || windows.single().id != primaryAppWindowId)
    val budget =
      HierarchySnapshotBudget(
        snapshotOptions,
        slotCount = maxOf(1, windows.size + if (reserveFallback) 1 else 0),
      )
    var mainHierarchy: UIElementInfo? = null
    var mainPackageName: String? = null
    var intentChooserDetected = false
    var notificationPermissionDetected: Boolean? = null
    var activeWindowLayer = 0
    var activeWindowKey: Int? = null
    val windowInfos = mutableListOf<WindowInfo>()
    val contentHiddenRegionRoots = mutableListOf<UIElementInfo>()

    // Track whether the accessibility service hierarchy is incomplete
    // This happens when active windows have null roots or only system UI is accessible
    var activeWindowHasNullRoot = false
    var primaryAppWindowHasNullRoot = false
    var hasApplicationWindow = false

    // The primary app window's own bounds, used below to correlate a permission-controller
    // dialog window with the app it belongs to (issue #6151 follow-up). `null` when no distinct
    // primary window was picked, in which case `isPrimaryWindow` already covers the active
    // window directly and correlation is moot.
    val primaryAppWindowBounds: Rect? = primaryAppWindowId?.let { id ->
      windows.firstOrNull { it.id == id }?.let { w -> Rect().also(w::getBoundsInScreen) }
    }

    fun capture(): ViewHierarchy {
      for (window in windows) captureWindow(window)
      recoverActiveWindow()
      applyOcclusion()
      return result()
    }

    private fun captureWindow(window: AccessibilityWindowInfo) {
      val windowBudget = budget.openScope()
      var rootNode: AccessibilityNodeInfo? = null
      val prototypeTitle = hasPrototypeTitle(window.type, window.title)
      var prototypeRootRead = false
      try {
        rootNode = window.root
        prototypeRootRead = recordWindowRoot(window, rootNode, prototypeTitle)
        if (rootNode == null) return
        captureWindowRoot(window, rootNode, windowBudget)
      } catch (e: IllegalArgumentException) {
        if (prototypeTitle && !prototypeRootRead) prototypeRootUnreadable = true
        Log.e(TAG, "Error extracting hierarchy from window ${window.id}", e)
      } catch (e: IllegalStateException) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        if (prototypeTitle && !prototypeRootRead) prototypeRootUnreadable = true
        Log.e(TAG, "Error extracting hierarchy from window ${window.id}", e)
      } catch (e: SecurityException) {
        if (prototypeTitle && !prototypeRootRead) prototypeRootUnreadable = true
        Log.e(TAG, "Error extracting hierarchy from window ${window.id}", e)
      } finally {
        finishWindowScope(windowInfos, window.id, windowBudget)
        rootNode?.recycle()
      }
    }

    private fun recordWindowRoot(
      window: AccessibilityWindowInfo,
      rootNode: AccessibilityNodeInfo?,
      prototypeTitle: Boolean,
    ): Boolean {
      if (rootNode == null) {
        prototypeRootUnreadable = prototypeRootUnreadable || prototypeTitle
        primaryAppWindowHasNullRoot = primaryAppWindowHasNullRoot || window.id == primaryAppWindowId
        activeWindowHasNullRoot = activeWindowHasNullRoot || window.isActive
        logNullWindowRoot(window, primaryAppWindowId)
        return false
      }
      if (!prototypeTitle) return false
      val packageName = rootNode.packageName?.toString()
      val prototypeRootRead = packageName != null
      ownPrototypeWindowCaptured =
        ownPrototypeWindowCaptured || packageName == DEFAULT_CTRL_PROXY_PACKAGE
      prototypeRootUnreadable = prototypeRootUnreadable || !prototypeRootRead
      return prototypeRootRead
    }

    private fun captureWindowRoot(
      window: AccessibilityWindowInfo,
      rootNode: AccessibilityNodeInfo,
      windowBudget: HierarchySnapshotBudget,
    ) {
      val windowLayer = window.layer
      if (window.isActive) {
        activeWindowLayer = windowLayer
        activeWindowKey = window.id
      }

      val windowType = windowTypeName(window)

      // Track if we successfully extract from any application window
      // Only TYPE_APPLICATION counts - IME, overlays, and system windows don't represent app
      // content
      if (window.type == AccessibilityWindowInfo.TYPE_APPLICATION) {
        hasApplicationWindow = true
      }

      val windowBounds = Rect()
      window.getBoundsInScreen(windowBounds)
      windowInfos.add(
        windowInfo(
          window,
          windowBounds,
          displayId,
          panelUniqueId,
          rootNode.packageName?.toString(),
        ),
      )
      val element =
        extractNodeInfo(
          rootNode,
          0,
          NodeExtraction(
            textFilter,
            screenDimensions,
            dedupeTextContentDesc,
            accessibilityFocusedNode,
            windowBudget,
          ),
          parentPath = "w${window.id}",
        )
      if (element != null) {
        contentHiddenRegionRoots.add(element)
      }
      recordWindowElement(
        window,
        element,
        CapturedWindow(rootNode, windowBounds, windowType, windowLayer),
      )
    }

    private fun recordWindowElement(
      window: AccessibilityWindowInfo,
      element: UIElementInfo?,
      captured: CapturedWindow,
    ) {
      val processedElement = processWindowElement(element, disableAllFiltering)
      val packageName = captured.root.packageName?.toString()
      if (!intentChooserDetected && processedElement != null) {
        intentChooserDetected = detectIntentChooserIndicators(processedElement)
      }

      // Prefer a focused application window, or the app below an IME that owns focus.
      val isPrimaryWindow =
        if (primaryAppWindowId != null) window.id == primaryAppWindowId else window.isActive
      if (isPrimaryWindow) {
        mainHierarchy = processedElement
        mainPackageName = packageName
      }
      // A runtime permission dialog is its own permissioncontroller window. Detect it in the
      // primary window or in a focused/active one that also overlaps the primary app window's
      // bounds (a dialog owns focus while it is on screen, even mid-transition when selection
      // still lands on the app beneath it), so the flag cannot read false while the dialog is
      // up (#6151). A focused/active window that does NOT overlap the primary app — e.g.
      // another app's own dialog in an unrelated split-screen pane — does not flag the
      // primary
      // app's observation (#6151 follow-up: cross-app false-positive correlation).
      updatePermissionDialog(
        window,
        processedElement,
        packageName,
        isPrimaryWindow,
        captured.bounds,
      )

      if (processedElement != null) {
        windowEntries.add(
          WindowEntry(
            windowId = window.id,
            windowType = captured.type,
            windowLayer = captured.layer,
            packageName = packageName,
            isActive = window.isActive,
            isFocused = window.isFocused,
            hierarchy = processedElement,
            windowBounds = ElementBounds(captured.bounds),
            isOwnPrototype = hasPrototypeTitle(window.type, window.title),
          ),
        )
      }
    }

    private fun updatePermissionDialog(
      window: AccessibilityWindowInfo,
      processedElement: UIElementInfo?,
      packageName: String?,
      isPrimaryWindow: Boolean,
      windowBounds: Rect,
    ) {
      val canCarryDialog =
        isPrimaryWindow ||
          ((window.isFocused || window.isActive) &&
            (primaryAppWindowBounds == null ||
              Rect.intersects(primaryAppWindowBounds, windowBounds)))
      if (notificationPermissionDetected != true && processedElement != null && canCarryDialog) {
        notificationPermissionDetected =
          detectNotificationPermissionDialog(processedElement, packageName)
      }
    }

    private fun recoverActiveWindow() {
      // Fallback to activeWindowRoot when it can still recover application content. When the
      // selected app has no root, rootInActiveWindow can be the active system status bar, which
      // is
      // not a substitute for application content.
      val canRecoverActiveWindow =
        mainHierarchy == null &&
          activeWindowRoot != null &&
          (!primaryAppWindowHasNullRoot ||
            activeWindowRoot.packageName?.toString()?.let { it != "com.android.systemui" } == true)
      if (canRecoverActiveWindow) {
        captureRecoveredWindow()
      } else if (reserveFallback) {
        budget.inScope { /* Release the unused fallback reservation. */ }
      }
    }

    private fun captureRecoveredWindow() {
      val (element, fallbackReasons) =
        budget.inScope(reserved = reserveFallback) { fallbackBudget ->
          val extracted =
            extractNodeInfo(
              checkNotNull(activeWindowRoot),
              0,
              NodeExtraction(
                textFilter,
                screenDimensions,
                dedupeTextContentDesc,
                accessibilityFocusedNode,
                fallbackBudget,
              ),
            )
          extracted to fallbackBudget.truncationReasons().ifEmpty { null }
        }
      if (element != null) {
        contentHiddenRegionRoots.add(element)
      }
      // Skip optimization if disableAllFiltering is true
      mainHierarchy =
        if (disableAllFiltering) {
          element
        } else {
          element?.let { wrapOptimizedElements(optimizeHierarchy(it)) }
        }
      mainPackageName = checkNotNull(activeWindowRoot).packageName?.toString()
      if (!intentChooserDetected && mainHierarchy != null) {
        intentChooserDetected = detectIntentChooserIndicators(checkNotNull(mainHierarchy))
      }
      if (notificationPermissionDetected != true && mainHierarchy != null) {
        notificationPermissionDetected =
          detectNotificationPermissionDialog(checkNotNull(mainHierarchy), mainPackageName)
      }
      recordRecoveredWindow(fallbackReasons)
    }

    private fun recordRecoveredWindow(fallbackReasons: List<String>?) {
      val fallbackWindowId = activeWindowKey ?: DEFAULT_WINDOW_KEY
      if (mainHierarchy != null || fallbackReasons != null) {
        recordFallbackWindow(
          windowInfos,
          WindowInfo(
            id = fallbackWindowId,
            displayId = displayId,
            panelUniqueId = panelUniqueId,
            type = AccessibilityWindowInfo.TYPE_APPLICATION,
            windowLayer = activeWindowLayer,
            isActive = true,
            isFocused = true,
            truncationReasons = fallbackReasons,
          ),
        )
      }
      if (mainHierarchy != null) {
        val fallbackEntry =
          WindowEntry(
            windowId = fallbackWindowId,
            windowType = "application",
            windowLayer = activeWindowLayer,
            packageName = mainPackageName,
            isActive = true,
            isFocused = true,
            hierarchy = checkNotNull(mainHierarchy),
            windowBounds = windowInfos.firstOrNull { it.id == fallbackWindowId }?.bounds,
          )
        val existingIndex = windowEntries.indexOfFirst { it.windowId == fallbackWindowId }
        if (existingIndex >= 0) {
          windowEntries[existingIndex] = fallbackEntry
        } else {
          windowEntries.add(fallbackEntry)
        }
      }
    }

    private fun applyOcclusion() {
      // Skip occlusion filtering when disabled (disableAllFiltering or the --no-occlusion
      // daemon flag), or when there's only one window (within-window "occlusion" between peer
      // subtrees like notification_panel and keyguard_message_area_container incorrectly strips
      // content in system UI)
      val occlusionFilteringActive =
        isOcclusionFilteringActive(disableAllFiltering, occlusionEnabled, windowEntries.size)
      Log.d(
        TAG,
        "Occlusion filtering active: $occlusionFilteringActive " +
          "(disableAllFiltering=$disableAllFiltering, occlusionEnabled=$occlusionEnabled, " +
          "windowCount=${windowEntries.size})",
      )
      if (occlusionFilteringActive) {
        val occlusionInfo = buildOcclusionInfo(windowEntries)
        val filteredEntries = windowEntries.mapNotNull { windowEntry ->
          val hierarchy =
            filterOccludedHierarchy(
              windowEntry.hierarchy,
              occlusionInfo,
              windowEntry.windowId,
              path = "",
              isRoot = true,
            )
          hierarchy?.let { windowEntry.copy(hierarchy = it) }
        }
        windowEntries.clear()
        windowEntries.addAll(filteredEntries)
        // Re-select the same primary application hierarchy after occlusion filtering.
        mainHierarchy =
          windowEntries
            .firstOrNull {
              if (primaryAppWindowId != null) it.windowId == primaryAppWindowId else it.isActive
            }
            ?.hierarchy ?: mainHierarchy
      }
    }

    private fun result(): ViewHierarchy {
      val capturedPrototype: Boolean? =
        when {
          ownPrototypeWindowCaptured -> true
          prototypeRootUnreadable -> null
          else -> false
        }
      val captureDisplayId =
        displayId ?: windowInfos.firstOrNull()?.displayId ?: Display.DEFAULT_DISPLAY
      if (windowEntries.isEmpty()) {
        Log.w(
          TAG,
          "[HIERARCHY-DEBUG] No visible windows available after filtering - marking as incomplete for fallback",
        )
        return ViewHierarchy(
          error = "No visible windows available",
          ctrlProxyIncomplete = true,
          prototypeHiddenReason = prototypeHiddenReason(captureDisplayId, capturedPrototype),
          windows = windowInfos.takeIf { budget.truncationReasons().isNotEmpty() },
          truncationReasons = budget.truncationReasons().ifEmpty { null },
        )
      }

      val sortedWindowRoots = sortedWindowRoots(windowEntries, windowInfos, panelUniqueId)
      val unifiedHierarchy =
        if (sortedWindowRoots.isEmpty()) null else UIElementInfo(children = sortedWindowRoots)

      val accessibilityFocusedElement = unifiedHierarchy?.let {
        findAccessibilityFocusedElement(it)
      }

      val ctrlProxyIncompleteReason =
        incompleteReason(
          activeWindowHasNullRoot,
          primaryAppWindowHasNullRoot,
          hasApplicationWindow,
          mainPackageName,
        )
      val ctrlProxyIncomplete = ctrlProxyIncompleteReason != null
      if (ctrlProxyIncomplete) {
        Log.w(
          TAG,
          "[HIERARCHY-DEBUG] Accessibility service incomplete: activeWindowHasNullRoot=$activeWindowHasNullRoot, primaryAppWindowHasNullRoot=$primaryAppWindowHasNullRoot, hasApplicationWindow=$hasApplicationWindow",
        )
      }

      return ViewHierarchy(
        packageName = mainPackageName,
        userId = android.os.Process.myUid() / ANDROID_USER_ID_RANGE,
        hierarchy = unifiedHierarchy?.let { WireNodeCodec.materialize(it) },
        windows = windowInfos.takeIf { it.isNotEmpty() },
        intentChooserDetected = intentChooserDetected,
        notificationPermissionDetected = notificationPermissionDetected,
        accessibilityFocusedElement =
          accessibilityFocusedElement?.let { WireNodeCodec.materialize(it) },
        ctrlProxyIncomplete = if (ctrlProxyIncomplete) true else null,
        ctrlProxyIncompleteReason = ctrlProxyIncompleteReason,
        contentHiddenRegions =
          detectContentHiddenRegions(contentHiddenRegionRoots, screenDimensions),
        truncationReasons = budget.truncationReasons().ifEmpty { null },
        prototypeSuspended = prototypeSuspended().takeIf { it },
        prototypeHiddenReason = prototypeHiddenReason(captureDisplayId, capturedPrototype),
      )
    }
  }

  private fun sortedWindowRoots(
    windowEntries: List<WindowEntry>,
    windowInfos: List<WindowInfo>,
    panelUniqueId: String?,
  ): List<UIElementInfo> {
    return windowEntries
      .sortedWith(compareBy<WindowEntry> { it.windowLayer }.thenBy { it.windowId })
      .map {
        // Preserve IME ownership after window roots are combined (issue #6795).
        // The desktop projection folds this subtree; raw captures retain every key.
        if (it.windowType == "input_method" && !it.packageName.isNullOrBlank()) {
          it.hierarchy.copy(
            windowId = it.windowId,
            displayId = windowInfos.firstOrNull { info -> info.id == it.windowId }?.displayId,
            panelUniqueId = panelUniqueId,
            extras = it.hierarchy.extras.orEmpty() + ("automobile:imePackage" to it.packageName),
          )
        } else {
          it.hierarchy.copy(
            windowId = it.windowId,
            displayId = windowInfos.firstOrNull { info -> info.id == it.windowId }?.displayId,
            panelUniqueId = panelUniqueId,
          )
        }
      }
  }

  private fun incompleteReason(
    activeWindowHasNullRoot: Boolean,
    primaryAppWindowHasNullRoot: Boolean,
    hasApplicationWindow: Boolean,
    mainPackageName: String?,
  ): String? {
    // Determine if the accessibility service hierarchy is incomplete
    // This happens when:
    // 1. An active window has a null root (app restricts accessibility access)
    // 2. The selected application window has a null root
    // 3. Only system UI windows were successfully extracted (no app windows accessible)
    val isSystemUiForeground = mainPackageName == "com.android.systemui"
    // When causes overlap, prefer the active null root, then the selected app null root,
    // then the absence of any accessible app window. Keep the flag and reason in sync.
    return when {
      activeWindowHasNullRoot -> INCOMPLETE_ACTIVE_WINDOW_NULL_ROOT
      primaryAppWindowHasNullRoot -> INCOMPLETE_APP_WINDOW_NULL_ROOT
      !hasApplicationWindow && !isSystemUiForeground -> INCOMPLETE_NO_APP_WINDOW_ROOT
      else -> null
    }
  }

  private fun windowTypeName(window: AccessibilityWindowInfo): String {
    return when (window.type) {
      AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
      AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "input_method"
      AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
      AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "accessibility_overlay"
      AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "split_screen_divider"
      AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY -> "magnification_overlay"
      else -> "unknown_${window.type}"
    }
  }

  private fun findAccessibilityFocus(
    windows: List<AccessibilityWindowInfo>,
    activeWindowRoot: AccessibilityNodeInfo?,
  ): AccessibilityNodeInfo? {
    var accessibilityFocusedNode: AccessibilityNodeInfo? = null
    for (window in windows) {
      val rootNode =
        try {
          window.root
        } catch (error: IllegalArgumentException) {
          Log.d(TAG, "Could not read window root for accessibility focus", error)
          null
        } catch (error: IllegalStateException) {
          if (error is kotlinx.coroutines.CancellationException) throw error
          Log.d(TAG, "Could not read window root for accessibility focus", error)
          null
        } catch (error: SecurityException) {
          Log.d(TAG, "Could not read window root for accessibility focus", error)
          null
        } ?: continue
      try {
        val focusedInWindow = rootNode.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
        if (focusedInWindow != null) {
          accessibilityFocusedNode = focusedInWindow
          break
        }
      } finally {
        rootNode.recycle()
      }
    }
    // Fallback to activeWindowRoot if not found in windows list
    if (accessibilityFocusedNode == null && activeWindowRoot != null) {
      accessibilityFocusedNode =
        activeWindowRoot.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
    }
    return accessibilityFocusedNode
  }

  private fun logNullWindowRoot(window: AccessibilityWindowInfo, primaryAppWindowId: Int?) {
    if (window.id == primaryAppWindowId) {
      Log.w(
        TAG,
        "[HIERARCHY-DEBUG] Primary application window ${window.id} has null root node - accessibility service incomplete",
      )
    }
    if (window.isActive) {
      Log.w(
        TAG,
        "[HIERARCHY-DEBUG] Active window ${window.id} has null root node - accessibility service incomplete",
      )
    } else {
      Log.d(TAG, "[HIERARCHY-DEBUG] Window ${window.id} has null root node, skipping")
    }
  }

  private fun processWindowElement(
    element: UIElementInfo?,
    disableAllFiltering: Boolean,
  ): UIElementInfo? =
    if (disableAllFiltering) element
    else element?.let { wrapOptimizedElements(optimizeHierarchy(it)) }

  private fun finishWindowScope(
    windowInfos: MutableList<WindowInfo>,
    windowId: Int,
    budget: HierarchySnapshotBudget,
  ) {
    budget.finish()
    val index = windowInfos.indexOfFirst { it.id == windowId }
    if (index >= 0) {
      windowInfos[index] =
        windowInfos[index].copy(truncationReasons = budget.truncationReasons().ifEmpty { null })
    }
  }

  private fun recordFallbackWindow(windowInfos: MutableList<WindowInfo>, fallback: WindowInfo) {
    val index = windowInfos.indexOfFirst { it.id == fallback.id }
    if (index < 0) {
      windowInfos.add(fallback)
    } else {
      // Fallback replaces this window's tree, so attribution describes the replacement scope.
      // The snapshot budget still retains the reasons from the original extraction.
      windowInfos[index] = windowInfos[index].copy(truncationReasons = fallback.truncationReasons)
    }
  }

  private fun windowInfo(
    window: AccessibilityWindowInfo,
    bounds: Rect,
    displayId: Int?,
    panelUniqueId: String?,
    packageName: String?,
  ): WindowInfo {
    // Both layers' windows (the app layer reports as TYPE_SYSTEM) carry the metadata; the title
    // keeps SystemUI's type-3 windows and the highlight overlay out (#10544).
    val prototypeMetadata =
      if (hasPrototypeTitle(window.type, window.title))
        ownPrototypeMetadata(packageName, window.title)
      else null
    return WindowInfo(
      id = window.id,
      displayId =
        displayId
          ?: if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) window.displayId
          else Display.DEFAULT_DISPLAY,
      panelUniqueId = panelUniqueId,
      type = window.type,
      windowLayer = window.layer,
      isActive = window.isActive,
      isFocused = window.isFocused,
      bounds = ElementBounds(bounds),
      packageName = packageName,
      prototypeId = if (prototypeMetadata != null) prototypeIdOfTitle(window.title) else null,
      prototypePlacement = prototypeMetadata?.placement,
      prototypeOpaque = prototypeMetadata?.opaque,
      prototypeAppearance = prototypeMetadata?.appearance,
    )
  }

  private fun detectContentHiddenRegions(
    roots: List<UIElementInfo>,
    screenDimensions: ScreenDimensions?,
  ): List<ContentHiddenRegion>? {
    return roots
      .flatMap {
        val (screenWidth, screenHeight) = resolveScreenDimensions(it, screenDimensions)
        detectContentHiddenRegions(it, screenWidth, screenHeight)
      }
      .distinctBy { it.bounds }
      .takeIf { it.isNotEmpty() }
  }

  private fun resolveScreenDimensions(
    element: UIElementInfo,
    screenDimensions: ScreenDimensions?,
  ): Pair<Int, Int> {
    if (screenDimensions?.isValid() == true) {
      return Pair(screenDimensions.width, screenDimensions.height)
    }
    val bounds = element.bounds
    return Pair(bounds?.right ?: 0, bounds?.bottom ?: 0)
  }

  private fun detectContentHiddenRegions(
    root: UIElementInfo,
    screenWidth: Int,
    screenHeight: Int,
  ): List<ContentHiddenRegion> {
    val screenArea = screenWidth * screenHeight
    if (screenArea <= 0) {
      return emptyList()
    }

    val candidates = mutableListOf<ContentHiddenRegion>()

    fun visit(node: UIElementInfo, isComposeDescendant: Boolean) {
      val nodeIsComposeView = node.className?.contains("ComposeView") == true
      val children = visibleChildren(node)

      if (isComposeDescendant && isLikelyComposeInteropHiddenBoundary(node, children, screenArea)) {
        val bounds = node.bounds ?: return
        val areaPercent = ((bounds.area().toDouble() / screenArea.toDouble()) * 100).toInt()
        candidates.add(
          ContentHiddenRegion(
            bounds = bounds,
            reason = CONTENT_HIDDEN_REASON_COMPOSE_INTEROP,
            areaPercent = areaPercent,
          ),
        )
        return
      }

      val childIsComposeDescendant = isComposeDescendant || nodeIsComposeView
      for (child in children) {
        visit(child, childIsComposeDescendant)
      }
    }

    visit(root, false)
    return candidates
  }

  private fun isLikelyComposeInteropHiddenBoundary(
    node: UIElementInfo,
    children: List<UIElementInfo>,
    screenArea: Int,
  ): Boolean {
    val bounds = node.bounds ?: return false
    val nodeArea = bounds.area()
    if (nodeArea <= 0) {
      return false
    }

    val areaPercent = nodeArea.toDouble() / screenArea.toDouble()
    if (areaPercent <= MIN_HIDDEN_REGION_SCREEN_AREA) {
      return false
    }

    if (hasTextContent(node)) {
      return false
    }

    if (isInteractive(node)) {
      return false
    }

    val childCoverage = directChildCoverage(bounds, children)
    return childCoverage <= MAX_VISIBLE_CHILD_COVERAGE
  }

  private fun hasTextContent(node: UIElementInfo): Boolean {
    return !node.text.isNullOrBlank() || !node.contentDesc.isNullOrBlank()
  }

  private fun isInteractive(node: UIElementInfo): Boolean {
    val actions = node.actions.orEmpty()
    return node.isClickable ||
      node.isScrollable ||
      node.isLongClickable ||
      actions.any {
        it == "click" || it == "long_click" || it == "scroll_forward" || it == "scroll_backward"
      }
  }

  private fun directChildCoverage(
    parentBounds: ElementBounds,
    children: List<UIElementInfo>,
  ): Double {
    if (children.isEmpty()) {
      return 0.0
    }
    val coveredArea = children.sumOf { child ->
      val childBounds = child.bounds ?: return@sumOf 0
      val left = max(parentBounds.left, childBounds.left)
      val top = max(parentBounds.top, childBounds.top)
      val right = min(parentBounds.right, childBounds.right)
      val bottom = min(parentBounds.bottom, childBounds.bottom)
      val width = max(0, right - left)
      val height = max(0, bottom - top)
      width * height
    }
    return coveredArea.toDouble() / parentBounds.area().toDouble()
  }

  private fun ElementBounds.area(): Int = width * height

  /** Detect intent chooser indicators in an optimized hierarchy. */
  private fun detectIntentChooserIndicators(element: UIElementInfo): Boolean {
    val textIndicators =
      setOf("Choose an app", "Open with", "Complete action using", "Always", "Just once")

    val classIndicators =
      listOf(
        "com.android.internal.app.ChooserActivity",
        "com.android.internal.app.ResolverActivity",
      )

    val resourceIdIndicators =
      listOf(
        "android:id/button_always",
        "android:id/button_once",
        "resolver_list",
        "chooser_list",
      )

    val nodeText = element.text ?: element.contentDesc ?: ""
    if (textIndicators.contains(nodeText)) {
      return true
    }

    val nodeClass = element.className ?: ""
    if (classIndicators.any { nodeClass.contains(it) }) {
      return true
    }

    val resourceId = element.resourceId ?: ""
    if (resourceIdIndicators.any { resourceId.contains(it) }) {
      return true
    }

    for (child in visibleChildren(element)) {
      if (detectIntentChooserIndicators(child)) {
        return true
      }
    }

    return false
  }

  internal fun detectIntentChooserIndicatorsForTest(element: UIElementInfo): Boolean {
    return detectIntentChooserIndicators(element)
  }

  /** Detect notification permission dialog indicators in an optimized hierarchy. */
  private fun detectNotificationPermissionDialog(
    element: UIElementInfo,
    packageName: String?,
  ): Boolean {
    if (packageName.isNullOrBlank() || !packageName.contains("permissioncontroller", true)) {
      return false
    }

    val scan = PermissionScan()
    scan.visit(element)
    return scan.hasNotificationText && scan.hasPermissionButtons
  }

  private inner class PermissionScan {
    var hasNotificationText = false
    var hasPermissionButtons = false

    fun visit(node: UIElementInfo) {
      val text = (node.text ?: node.contentDesc ?: "").lowercase()
      if (text.contains("notification")) {
        hasNotificationText = true
      }

      val resourceId = node.resourceId?.lowercase() ?: ""
      if (
        resourceId.contains("permission_allow_button") ||
          resourceId.contains("permission_deny_button")
      ) {
        hasPermissionButtons = true
      }

      if (hasNotificationText && hasPermissionButtons) {
        return
      }

      visitChildren(node)
    }

    fun visitChildren(node: UIElementInfo) {
      for (child in visibleChildren(node)) {
        visit(child)
        if (hasNotificationText && hasPermissionButtons) {
          return
        }
      }
    }
  }

  internal fun detectNotificationPermissionDialogForTest(
    element: UIElementInfo,
    packageName: String?,
  ): Boolean {
    return detectNotificationPermissionDialog(element, packageName)
  }

  /**
   * Selects the window id hierarchy extraction should treat as the "primary" user-facing window.
   * Prefers a focused application window even when its root is temporarily unavailable. When the
   * IME owns focus, or when no window reports focus at all, falls back to the topmost application
   * window with a root. Returns null when neither condition applies so callers can retain the
   * active-window fallback for genuine system UI (a focused shade, quick settings, or keyguard).
   *
   * Android can mark a system window active while the foreground application is focused, and marks
   * the IME active/focused while the keyboard is showing. In either case, relying on
   * [AccessibilityWindowInfo.isActive] alone can select non-app content. The
   * [AccessibilityWindowInfo.isFocused] flag is not populated on every API level either; when it is
   * absent everywhere, an application window that has readable content still outranks a status bar
   * that merely happens to be marked active (#6151).
   *
   * Note that a focused application window whose root is null is a different failure: on Android
   * 14+ the framework hides accessibility-data-sensitive surfaces (runtime permission dialogs, the
   * Settings Wi-Fi picker) from services that do not declare `isAccessibilityTool`, which is why
   * the service config declares it. No ranking rule can recover content the framework withholds.
   */
  private fun pickPrimaryAppWindowId(windows: List<AccessibilityWindowInfo>): Int? =
    pickPrimaryAppWindowId(
      windows.map {
        WindowMeta(
          id = it.id,
          type = it.type,
          layer = it.layer,
          hasRoot = it.root != null,
          isFocused = it.isFocused,
          isActive = it.isActive,
        )
      },
    )

  /**
   * Test-only metadata shape so primary-window selection can be unit-tested without mocking
   * [AccessibilityWindowInfo].
   */
  internal data class WindowMeta(
    val id: Int,
    val type: Int,
    val layer: Int,
    val hasRoot: Boolean,
    val isFocused: Boolean = false,
    val isActive: Boolean = false,
  )

  /** Single-pass variant used by tests and by the production overload. */
  internal fun pickPrimaryAppWindowId(windows: List<WindowMeta>): Int? {
    val selection = PrimaryWindowSelection()
    for (window in windows) selection.consider(window)
    return selection.result()
  }

  private class PrimaryWindowSelection {
    var hasIme = false
    var anyWindowFocused = false
    var focusedAppId: Int? = null
    var focusedAppLayer = Int.MIN_VALUE
    var activeAppId: Int? = null
    var topAppId: Int? = null
    var topAppLayer = Int.MIN_VALUE

    fun consider(w: WindowMeta) {
      if (w.isFocused) anyWindowFocused = true
      when (w.type) {
        AccessibilityWindowInfo.TYPE_INPUT_METHOD -> if (w.hasRoot) hasIme = true
        AccessibilityWindowInfo.TYPE_APPLICATION -> {
          if (w.hasRoot && w.isActive) {
            activeAppId = w.id
          }
          if (w.hasRoot && w.layer > topAppLayer) {
            topAppLayer = w.layer
            topAppId = w.id
          }
          if (w.isFocused && w.layer > focusedAppLayer) {
            focusedAppLayer = w.layer
            focusedAppId = w.id
          }
        }
      }
    }

    fun result(): Int? {
      if (focusedAppId != null) {
        return focusedAppId
      }
      // The IME owns focus, or the focus flag is populated nowhere: the application window with
      // readable content is the user-facing window — the active one when several coexist
      // (split-screen, picture-in-picture), else the topmost. A focused non-app window (shade,
      // quick settings, keyguard) keeps the active-window fallback.
      return if (hasIme || !anyWindowFocused) activeAppId ?: topAppId else null
    }
  }

  private fun extractChildNodes(
    node: AccessibilityNodeInfo,
    childCount: Int,
    extract: (AccessibilityNodeInfo, Int) -> UIElementInfo?,
  ): List<UIElementInfo> {
    val children = mutableListOf<UIElementInfo>()
    for (index in 0 until childCount) {
      val child = node.getChild(index) ?: continue
      try {
        val childInfo = extract(child, index)
        if (childInfo != null) children.add(childInfo)
      } finally {
        child.recycle()
      }
    }
    return children
  }

  /**
   * Recursively extracts node information with depth limiting, offscreen filtering, and zero-area
   * filtering.
   *
   * @param node The accessibility node to extract
   * @param depth Current recursion depth
   * @param textFilter Optional text filter
   * @param screenDimensions Optional screen dimensions for offscreen filtering
   * @param dedupeTextContentDesc When true, omit content-desc when it equals text
   * @param accessibilityFocusedNode The node that has accessibility focus (TalkBack cursor)
   */
  private data class NodeExtraction(
    val textFilter: String?,
    val screenDimensions: ScreenDimensions?,
    val dedupeTextContentDesc: Boolean,
    val accessibilityFocusedNode: AccessibilityNodeInfo?,
    val budget: HierarchySnapshotBudget,
  )

  private fun extractNodeInfo(
    node: AccessibilityNodeInfo,
    depth: Int,
    context: NodeExtraction,
    parentPath: String = "",
    childIndex: Int = 0,
  ): UIElementInfo? {
    stats.nodesVisited.incrementAndGet()
    if (!context.budget.enter(depth)) {
      return null
    }

    return try {
      val bounds = Rect()
      node.getBoundsInScreen(bounds)
      val elementBounds = ElementBounds(bounds)

      // Filter completely offscreen nodes early to avoid processing subtrees
      if (elementBounds.isCompletelyOffscreen(context.screenDimensions)) {
        return null
      }

      // We intentionally do NOT filter on node.isVisibleToUser here. Android's flag is
      // unreliable: Compose LazyColumn items, collapsed notification group children, and nodes
      // behind an IME are all marked invisible despite being rendered on-screen. We already
      // filter zero-area bounds and completely offscreen nodes above, which is sufficient.

      // Build deterministic path for viewId generation
      val segment =
        if (node.viewIdResourceName != null) {
          "$childIndex:${node.viewIdResourceName}"
        } else {
          childIndex.toString()
        }
      val currentPath = if (parentPath.isEmpty()) segment else "$parentPath/$segment"

      val children = mutableListOf<UIElementInfo>()
      val totalChildCount = node.childCount
      val childCount = min(totalChildCount, MAX_CHILDREN)
      if (totalChildCount > MAX_CHILDREN) {
        context.budget.recordChildCapTruncation()
      }

      children.addAll(
        extractChildNodes(node, childCount) { child, index ->
          extractNodeInfo(
            child,
            depth + 1,
            context,
            parentPath = currentPath,
            childIndex = index,
          )
        },
      )

      if (elementBounds.hasZeroArea() && children.isEmpty()) {
        return null
      }

      val elementInfo = NodeFields(node, context).build(bounds, currentPath, children)

      if (childCount == 0 && !meetsFilterCriteria(elementInfo, context.textFilter)) {
        null
      } else {
        elementInfo
      }
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Error extracting node info at depth $depth", e)
      null
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.e(TAG, "Error extracting node info at depth $depth", e)
      null
    } catch (e: SecurityException) {
      Log.e(TAG, "Error extracting node info at depth $depth", e)
      null
    }
  }

  /** Reads framework semantics in the same order as the depth-first extraction. */
  private inner class NodeFields(
    val node: AccessibilityNodeInfo,
    val context: NodeExtraction,
  ) {
    var text: String? = null
    var textSize: Float? = null
    var textColor: String? = null
    var tooltipText: String? = null
    var paneTitle: String? = null
    var liveRegion: String? = null
    var collectionInfo: String? = null
    var collectionItemInfo: String? = null
    var collectionRowIndex: Int? = null
    var collectionColumnIndex: Int? = null
    var rangeInfo: String? = null
    var inputType: String? = null
    var actions: List<String>? = null

    val extrasMap = extractExtras(node)
    val testTag = extractTestTag(extrasMap)
    val semanticLinks = if (node.isPassword) null else semanticLinksFromText(node.text)

    // Check direct APIs if available (API 30+) with an extras fallback for Compose on API < 30
    val stateDescription: String? = extractStateDescription(node, extrasMap)
    // AccessibilityNodeInfo.getHintText requires API 26 (minSdk is 24)
    val hintText: String? = if (Build.VERSION.SDK_INT >= 26) node.hintText?.toString() else null
    val errorMessage: String? = node.error?.toString()

    init {
      if (Build.VERSION.SDK_INT >= 28) {
        tooltipText = node.tooltipText?.toString()
        paneTitle = node.paneTitle?.toString()
      }
    }

    val apiGatedFields =
      apiGatedNodeFields(
        Build.VERSION.SDK_INT,
        uniqueId = if (Build.VERSION.SDK_INT >= 33) node.uniqueId else null,
        containerTitle = if (Build.VERSION.SDK_INT >= 34) node.containerTitle?.toString() else null,
      )

    init {
      readActions()
      readCollectionFields()
      readInputAndLiveRegion()
    }

    val className =
      if (node.className.isNullOrBlank() || GENERIC_CLASS_NAMES.contains(node.className)) {
        null
      } else {
        node.className?.toString()
      }

    init {
      node.text?.toString()?.let {
        // Mask password content to avoid leaking secrets through the hierarchy.
        // Mirrors iOS UIElementInfo.value masking for .secureTextField.
        text = if (node.isPassword) "•".repeat(it.length) else it
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          textSize = node.extraRenderingInfo?.textSizeInPx
        }
        textColor = null // Remove the getTextColorHex(node) call
      }
    }

    // Dedupe content-desc when it equals text (keep text, omit content-desc)
    val rawContentDesc = node.contentDescription?.toString()
    val contentDesc =
      if (context.dedupeTextContentDesc && rawContentDesc == text) {
        null
      } else {
        rawContentDesc
      }

    val recompositionEntry =
      if (
        recompositionStore?.isEnabled() == true &&
          recompositionStore.isForPackage(node.packageName?.toString())
      ) {
        recompositionStore.findMatch(extrasMap)
      } else {
        null
      }

    private fun readActions() {
      // Extract accessibility actions
      val actionList = node.actionList
      if (actionList != null && actionList.isNotEmpty()) {
        actions = actionList.mapNotNull { action -> NodeFieldNames.actions[action.id] }
        if (actions.isNullOrEmpty()) actions = null
      }
    }

    private fun readCollectionFields() {
      // Extract collection info
      node.collectionInfo?.let { collectionInfo = "rows:${it.rowCount},cols:${it.columnCount}" }

      // Extract collection item info
      node.collectionItemInfo?.let {
        collectionItemInfo = "row:${it.rowIndex},col:${it.columnIndex}"
        collectionRowIndex = it.rowIndex
        collectionColumnIndex = it.columnIndex
      }

      // Extract range info
      node.rangeInfo?.let { rangeInfo = "current:${it.current},min:${it.min},max:${it.max}" }
    }

    private fun readInputAndLiveRegion() {
      val inputTypeInt = node.inputType
      if (inputTypeInt != 0) inputType = NodeFieldNames.inputTypes[inputTypeInt]
      val liveRegionMode = node.liveRegion
      if (liveRegionMode != 0) {
        liveRegion =
          when (liveRegionMode) {
            1 -> "polite"
            2 -> "assertive"
            else -> "live_region_$liveRegionMode"
          }
      }
    }

    fun build(bounds: Rect, currentPath: String, children: List<UIElementInfo>): UIElementInfo {
      // Check if this node has accessibility focus
      val hasAccessibilityFocus =
        context.accessibilityFocusedNode != null && node == context.accessibilityFocusedNode

      // Generate viewId: use resourceId if available, otherwise deterministic UUID from path
      val viewId = node.viewIdResourceName ?: generateDeterministicUuid(currentPath)

      return UIElementInfo(
        text = text,
        textSize = textSize,
        textColor = textColor,
        contentDesc = contentDesc,
        className = className,
        resourceId = node.viewIdResourceName,
        viewId = viewId,
        bounds = ElementBounds(bounds),
        clickable = if (node.isClickable) "true" else null,
        enabled = if (!node.isEnabled) "false" else null, // Only include if disabled
        focusable = if (node.isFocusable) "true" else null,
        focused = if (node.isFocused) "true" else null,
        accessibilityFocused = if (hasAccessibilityFocus) "true" else null,
        scrollable = if (node.isScrollable) "true" else null,
        password = if (node.isPassword) "true" else null,
        checkable = if (node.isCheckable) "true" else null,
        checked = if (node.isCheckable) node.isChecked.toString() else null,
        selected = if (node.isSelected) "true" else null,
        longClickable = if (node.isLongClickable) "true" else null,
        children = children,
        stateDescription = stateDescription,
        testTag = testTag,
        semanticLinks = semanticLinks,
        uniqueId = apiGatedFields.uniqueId,
        visibleToUser = node.isVisibleToUser,
        containerTitle = apiGatedFields.containerTitle,
        hintText = hintText,
        errorMessage = errorMessage,
        tooltipText = tooltipText,
        paneTitle = paneTitle,
        liveRegion = liveRegion,
        collectionInfo = collectionInfo,
        collectionItemInfo = collectionItemInfo,
        collectionRowIndex = collectionRowIndex,
        collectionColumnIndex = collectionColumnIndex,
        rangeInfo = rangeInfo,
        inputType = inputType,
        actions = actions,
        extras = extrasMap,
        recomposition = recompositionEntry,
      )
    }
  }

  /**
   * Returns only the link metadata needed to discover native [ClickableSpan] activation.
   * Accessibility exposes these spans from API 26 onward; callers omit the field when absent.
   */
  internal fun semanticLinksFromText(
    text: CharSequence?,
    apiLevel: Int = Build.VERSION.SDK_INT,
  ): List<SemanticLink>? {
    if (apiLevel < Build.VERSION_CODES.O || text !is Spanned) return null
    val priorLinkTexts = mutableListOf<String>()
    val links =
      text
        .getSpans(0, text.length, ClickableSpan::class.java)
        .sortedWith(compareBy({ text.getSpanStart(it) }, { text.getSpanEnd(it) }))
        .mapNotNull { span ->
          val start = text.getSpanStart(span)
          val end = text.getSpanEnd(span)
          if (start < 0 || end <= start || end > text.length) return@mapNotNull null
          val visibleText = text.subSequence(start, end).toString()
          if (visibleText.isBlank()) return@mapNotNull null
          // Activation uses String.equals(ignoreCase = true); count prior links
          // with that exact equivalence rather than an approximate lowercase key.
          val occurrence = priorLinkTexts.count { it.equals(visibleText, ignoreCase = true) }
          priorLinkTexts += visibleText
          SemanticLink(visibleText, occurrence, start, end)
        }
    return links.ifEmpty { null }
  }

  private fun generateDeterministicUuid(path: String): String = GeneratedViewId.fromPath(path)

  /**
   * Find the accessibility-focused element in the hierarchy. Recursively searches for the element
   * with accessibilityFocused == "true".
   */
  private fun findAccessibilityFocusedElement(element: UIElementInfo): UIElementInfo? {
    // Check if this element has accessibility focus
    if (element.isAccessibilityFocused) {
      return element
    }

    // Recursively check children
    for (child in element.children) {
      val focusedInChild = findAccessibilityFocusedElement(child)
      if (focusedInChild != null) {
        return focusedInChild
      }
    }

    return null
  }

  /**
   * Typed children of [element], applying the same visibility filter the old JsonElement decoder
   * did: keep a child if it has its own descendants, otherwise only if it meets filter criteria.
   * Walks the in-memory [UIElementInfo.children] with zero (de)serialization (issue #5471).
   */
  internal fun visibleChildren(element: UIElementInfo): List<UIElementInfo> =
    element.children.filter { child ->
      child.children.isNotEmpty() || meetsFilterCriteria(child)
    }

  /**
   * Resolve the accessibility state description for a node.
   *
   * Jetpack Compose surfaces toggleable/selectable state (Switch, CheckBox, RadioButton,
   * `Modifier.toggleable`/`selectable`) as an accessibility state description ("On"/"Off",
   * "Checked"/"Unchecked"). When Compose sets a state description it deliberately does NOT set
   * [AccessibilityNodeInfo.isChecked] (to avoid double-announcement in TalkBack), so the toggle
   * flip is invisible unless the state description is captured (issue #3139).
   *
   * On API 30+ the value is available via the direct getter. On API 24-29 the androidx
   * accessibility compat shim stores it in the node's extras bundle under
   * [STATE_DESCRIPTION_EXTRA_KEY], so fall back to reading it there.
   */
  private fun extractStateDescription(
    node: AccessibilityNodeInfo,
    extras: Map<String, String>?,
  ): String? {
    if (Build.VERSION.SDK_INT >= 30) {
      node.stateDescription?.toString()?.let {
        if (it.isNotBlank()) return it
      }
    }
    return stateDescriptionFromExtras(extras)
  }

  /**
   * Pure extras-bundle fallback for the accessibility state description (see
   * [extractStateDescription]). Exposed for unit testing without a live [AccessibilityNodeInfo].
   */
  internal fun stateDescriptionFromExtras(extras: Map<String, String>?): String? =
    extras?.get(STATE_DESCRIPTION_EXTRA_KEY)?.takeIf { it.isNotBlank() }

  private fun extractExtras(node: AccessibilityNodeInfo): Map<String, String>? {
    val extras = node.extras ?: return null
    val keys = extras.keySet()
    if (keys.isNullOrEmpty()) return null

    val map = LinkedHashMap<String, String>()
    for (key in keys) {
      if (VolatileExtras.isNeverShipped(key)) continue
      val value = extras.get(key)
      if (value != null) {
        map[key] = value.toString()
      }
    }
    return map.ifEmpty { null }
  }

  private fun extractTestTag(extras: Map<String, String>?): String? = testTagFromExtras(extras)

  internal fun testTagFromExtras(extras: Map<String, String>?): String? {
    if (extras.isNullOrEmpty()) return null

    val candidates =
      listOf(
        "androidx.compose.ui.semantics.testTag",
        "androidx.compose.ui.semantics.TestTag",
        "androidx.compose.ui.testTag",
        "testTag",
        "test-tag",
      )

    for (key in candidates) {
      val value = extras[key]
      if (!value.isNullOrBlank()) {
        return value
      }
    }

    return extras.entries.firstOrNull { it.key.contains("testtag", ignoreCase = true) }?.value
  }

  internal data class ApiGatedNodeFields(
    val uniqueId: String?,
    val containerTitle: String?,
  )

  internal fun apiGatedNodeFields(
    sdkInt: Int,
    uniqueId: String?,
    containerTitle: String?,
  ): ApiGatedNodeFields =
    ApiGatedNodeFields(
      uniqueId = if (sdkInt >= 33) uniqueId else null,
      containerTitle = if (sdkInt >= 34) containerTitle else null,
    )

  /** Check if element meets filter criteria (matches test expectations) */
  private fun meetsFilterCriteria(element: UIElementInfo, textFilter: String? = null): Boolean {
    // String filter criteria
    val hasStringCriteria = hasStringCriteria(element)

    val hasBooleanCriteria = hasBooleanCriteria(element)
    val hasAccessibilityFeatures = hasAccessibilityFeatures(element)

    // Apply text filter if provided
    val meetsTextFilter =
      textFilter?.let { filter -> element.text?.contains(filter, true) ?: false } ?: true

    return (hasStringCriteria || hasBooleanCriteria || hasAccessibilityFeatures) && meetsTextFilter
  }

  private fun hasBooleanCriteria(element: UIElementInfo): Boolean {
    // Boolean filter criteria
    return element.clickable == "true" ||
      element.scrollable == "true" ||
      element.focusable == "true" ||
      element.focused == "true" ||
      element.checkable == "true" ||
      element.checked == "true" ||
      element.selected == "true" ||
      element.longClickable == "true" ||
      // The TalkBack cursor is semantic even on a node exposing only baseline focus actions, so
      // pruning must keep it for findAccessibilityFocusedElement (#14384).
      element.isAccessibilityFocused
  }

  private fun hasAccessibilityFeatures(element: UIElementInfo): Boolean {
    // Accessibility feature criteria
    return !element.liveRegion.isNullOrBlank() ||
      !element.collectionInfo.isNullOrBlank() ||
      !element.collectionItemInfo.isNullOrBlank() ||
      !element.rangeInfo.isNullOrBlank() ||
      !element.inputType.isNullOrBlank() ||
      (if (pruneBaselineWrappers)
        element.actions?.any { it !in NodeFieldNames.baselineAccessibilityActions } == true
      else !element.actions.isNullOrEmpty()) ||
      (if (pruneBaselineWrappers)
        element.extras?.keys?.any { !VolatileExtras.isNeverShipped(it) } == true
      else !element.extras.isNullOrEmpty())
  }

  private fun hasStringCriteria(element: UIElementInfo): Boolean {
    return !element.text.isNullOrBlank() ||
      !element.resourceId.isNullOrBlank() ||
      !element.contentDesc.isNullOrBlank() ||
      !element.testTag.isNullOrBlank() ||
      !element.uniqueId.isNullOrBlank() ||
      !element.containerTitle.isNullOrBlank() ||
      !element.role.isNullOrBlank() ||
      !element.stateDescription.isNullOrBlank() ||
      !element.errorMessage.isNullOrBlank() ||
      !element.hintText.isNullOrBlank() ||
      !element.tooltipText.isNullOrBlank() ||
      !element.paneTitle.isNullOrBlank()
  }

  private fun wrapOptimizedElements(elements: List<UIElementInfo>): UIElementInfo? {
    if (elements.isEmpty()) {
      return null
    }
    if (elements.size == 1) {
      return elements[0]
    }
    return UIElementInfo(children = elements)
  }

  /**
   * Optimizes the hierarchy by:
   * 1. Promoting children of bounds-only wrapper nodes (structural nodes with only bounds)
   * 2. Filtering out bounds-only intermediate nodes
   * 3. Preserving text-bearing children of interactive elements (e.g., Tab labels)
   *
   * This significantly reduces hierarchy size for complex UIs like YouTube.
   *
   * Walks the typed [UIElementInfo.children] list directly — no per-stage JSON decode/re-encode
   * (issue #5471).
   */
  internal fun optimizeHierarchy(element: UIElementInfo): List<UIElementInfo> {
    // Check if this element is a bounds-only wrapper (has no useful properties)
    val isBoundsOnlyWrapper = !meetsFilterCriteria(element)

    // Special handling: Never promote children of interactive elements (clickable/focusable)
    // This preserves Tab labels, NavigationBar labels, and other text children of interactive
    // parents
    val isInteractive =
      element.clickable == "true" ||
        element.focusable == "true" ||
        element.selected == "true" ||
        element.longClickable == "true"

    // Recursively optimize children on the typed tree.
    val optimizedChildren = element.children.flatMap { optimizeHierarchy(it) }

    // Only promote children (flatten hierarchy) if this is a bounds-only wrapper AND not
    // interactive
    if (isBoundsOnlyWrapper && !isInteractive) {
      if (optimizedChildren.isEmpty()) {
        if (logOptimizationDecisions) Log.d(TAG, "[OPT] -> FILTER OUT (bounds-only, no children)")
        return emptyList()
      }
      if (logOptimizationDecisions)
        Log.d(TAG, "[OPT] -> PROMOTE ${optimizedChildren.size} children")
      return optimizedChildren
    }

    if (logOptimizationDecisions) Log.d(TAG, "[OPT] -> KEEP (meets criteria or interactive)")
    return listOf(element.copy(children = optimizedChildren))
  }

  internal data class WindowEntry(
    val windowId: Int,
    val windowType: String,
    val windowLayer: Int,
    val packageName: String?,
    val isActive: Boolean,
    val isFocused: Boolean,
    val hierarchy: UIElementInfo,
    val windowBounds: ElementBounds? = null,
    /** CtrlProxy's own prototype window (either layer); never an occluder here. */
    val isOwnPrototype: Boolean = false,
  )

  enum class NodeRelationship {
    /** Nodes share the same direct parent */
    SIBLING,
    /** Occluder is a sibling of one of the node's ancestors */
    UNCLE,
    /** Occluder is a descendant (child/grandchild) of the node */
    DESCENDANT,
    /** No special relationship */
    UNRELATED,
  }

  /**
   * Determines the relationship between a node and a potential occluder based on their paths and
   * traversal order.
   *
   * NOTE: This function currently has no production callers. Same-window occlusion is skipped
   * unconditionally in [buildOcclusionInfo], and [applyOcclusionFilteringSingleWindow] was removed,
   * so nothing in production consults this relationship. It is retained (and kept semantically
   * correct, including the nephew and root-level cases below) for the future direction of running
   * occlusion on the pre-optimization tree, where path-based relationship detection is reliable
   * again. It is exercised only by unit tests today.
   *
   * @param nodePath The path of the node being checked (e.g., "0.0.0.1.0")
   * @param occluderPath The path of the potential occluder (e.g., "0.0.0.1.1")
   * @param nodeOrder The traversal order of the node
   * @param nodeSubtreeEnd The end of the node's subtree in traversal order
   * @param occluderOrder The traversal order of the occluder
   * @return The relationship between the two nodes
   */
  internal fun determineNodeRelationship(
    nodePath: String,
    occluderPath: String,
    nodeOrder: Int,
    nodeSubtreeEnd: Int,
    occluderOrder: Int,
  ): NodeRelationship {
    // Check if occluder is a descendant (child/grandchild) using traversal order
    val isDescendant = occluderOrder > nodeOrder && occluderOrder <= nodeSubtreeEnd
    if (isDescendant) {
      return NodeRelationship.DESCENDANT
    }

    // Extract parent paths
    val nodeParentPath = nodePath.substringBeforeLast('.', "")
    val occluderParentPath = occluderPath.substringBeforeLast('.', "")

    // Check if they're direct siblings (same parent). Root-level siblings have empty parent paths.
    if (nodeParentPath == occluderParentPath) {
      return NodeRelationship.SIBLING
    }

    // Check if occluder is a sibling of any ancestor of the node (uncle relationship)
    // If occluder's parent is a prefix of node's path, the occluder is an uncle of the node
    val isUncle =
      occluderParentPath.isNotEmpty() &&
        nodePath.startsWith(occluderParentPath + ".") &&
        occluderParentPath != nodeParentPath
    if (isUncle) {
      return NodeRelationship.UNCLE
    }

    // Check the reverse: if node is a sibling of any ancestor of the occluder (nephew relationship)
    // If node's parent is a prefix of occluder's path, the node is an uncle of the occluder.
    // After optimizeHierarchy promotes children from bounds-only wrappers, nodes at different
    // depths
    // can be visual siblings — this check prevents them from being classified as UNRELATED.
    val isNephew =
      nodeParentPath.isNotEmpty() &&
        occluderPath.startsWith(nodeParentPath + ".") &&
        nodeParentPath != occluderParentPath
    if (isNephew) {
      return NodeRelationship.UNCLE
    }

    // If either node is at the root level (empty parent path), they share the implicit root
    // as a common ancestor and should be treated as related.
    if (nodeParentPath.isEmpty() || occluderParentPath.isEmpty()) {
      return NodeRelationship.SIBLING
    }

    return NodeRelationship.UNRELATED
  }

  // applyOcclusionFilteringSingleWindow removed: within-window occlusion filtering is disabled
  // because optimizeHierarchy restructures the tree in ways that break path-based relationship
  // detection, causing false occlusion between visual siblings at different depths.

  /**
   * Whether the cross-window occlusion pass (buildOcclusionInfo + filterOccludedHierarchy) should
   * run for this extraction. `internal` so it's directly unit-testable without needing to stand up
   * a full multi-window AccessibilityNodeInfo tree.
   */
  internal fun isOcclusionFilteringActive(
    disableAllFiltering: Boolean,
    occlusionEnabled: Boolean,
    windowCount: Int,
  ): Boolean = !disableAllFiltering && occlusionEnabled && windowCount > 1

  private val occlusionCalculator = OcclusionCalculator(stats, GeneratedViewId::fromPath)

  // Keep the existing extraction/test entry points while the calculator owns the algorithm.
  private fun buildOcclusionInfo(
    windowEntries: List<WindowEntry>,
  ): Map<OcclusionCalculator.NodeKey, OcclusionCalculator.OcclusionInfo> =
    occlusionCalculator.buildOcclusionInfo(windowEntries)

  private fun filterOccludedHierarchy(
    element: UIElementInfo,
    occlusionInfo: Map<OcclusionCalculator.NodeKey, OcclusionCalculator.OcclusionInfo>,
    windowKey: Int,
    path: String,
    isRoot: Boolean,
  ): UIElementInfo? =
    occlusionCalculator.filterOccludedHierarchy(element, occlusionInfo, windowKey, path, isRoot)

  internal fun clipOccluderBounds(
    bounds: ElementBounds,
    windowBounds: ElementBounds?,
  ): ElementBounds? = OcclusionGeometry.clipOccluderBounds(bounds, windowBounds)

  internal fun calculateUnionArea(rectangles: List<ElementBounds>, maxArea: Int? = null): Int =
    OcclusionGeometry.calculateUnionArea(rectangles, maxArea)

  /** Extract information about a single focused element. Used for getCurrentFocus command. */
  fun extractFocusedElementInfo(focusedNode: AccessibilityNodeInfo): UIElementInfo? {
    return try {
      val bounds = Rect()
      focusedNode.getBoundsInScreen(bounds)
      val elementBounds = ElementBounds(bounds)

      // Extract basic info about the focused element
      val extrasMap = extractExtras(focusedNode)
      val testTag = extractTestTag(extrasMap)

      val stateDescription: String? = extractStateDescription(focusedNode, extrasMap)
      // AccessibilityNodeInfo.getHintText requires API 26 (minSdk is 24)
      val hintText: String? =
        if (Build.VERSION.SDK_INT >= 26) focusedNode.hintText?.toString() else null
      val errorMessage: String? = focusedNode.error?.toString()
      var tooltipText: String? = null
      var paneTitle: String? = null
      if (Build.VERSION.SDK_INT >= 28) {
        tooltipText = focusedNode.tooltipText?.toString()
        paneTitle = focusedNode.paneTitle?.toString()
      }

      val rawFocusedText = focusedNode.text?.toString()
      val focusedText =
        if (rawFocusedText != null && focusedNode.isPassword) "•".repeat(rawFocusedText.length)
        else rawFocusedText
      UIElementInfo(
        className = focusedNode.className?.toString(),
        resourceId = focusedNode.viewIdResourceName,
        text = focusedText,
        contentDesc = focusedNode.contentDescription?.toString(),
        clickable = focusedNode.isClickable.toString(),
        longClickable = focusedNode.isLongClickable.toString(),
        enabled = focusedNode.isEnabled.toString(),
        focusable = focusedNode.isFocusable.toString(),
        focused = focusedNode.isFocused.toString(),
        accessibilityFocused = focusedNode.isAccessibilityFocused.toString(),
        checkable = focusedNode.isCheckable.toString(),
        checked = focusedNode.isChecked.toString(),
        scrollable = focusedNode.isScrollable.toString(),
        password = focusedNode.isPassword.toString(),
        selected = focusedNode.isSelected.toString(),
        bounds = elementBounds,
        testTag = testTag,
        stateDescription = stateDescription,
        hintText = hintText,
        errorMessage = errorMessage,
        tooltipText = tooltipText,
        paneTitle = paneTitle,
      )
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Error extracting focused element info", e)
      null
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.e(TAG, "Error extracting focused element info", e)
      null
    } catch (e: SecurityException) {
      Log.e(TAG, "Error extracting focused element info", e)
      null
    }
  }

  /**
   * Extract traversal order from the active window. Returns an ordered list of
   * accessibility-focusable elements in TalkBack traversal order.
   */
  fun extractTraversalOrderFromActiveWindow(
    rootNode: AccessibilityNodeInfo?,
    screenDimensions: ScreenDimensions? = null,
  ): TraversalOrderResult {
    if (rootNode == null) {
      Log.w(TAG, "Root node is null for traversal order extraction")
      return TraversalOrderResult(elements = emptyList(), focusedIndex = null)
    }

    // Find accessibility-focused node
    val accessibilityFocusedNode = rootNode.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)

    // Collect focusable elements in traversal order
    val focusableElements = mutableListOf<UIElementInfo>()
    val truncationReasons = linkedSetOf<String>()
    var focusedIndex: Int? = null

    collectFocusableElements(
      rootNode,
      0,
      FocusTraversal(
        screenDimensions,
        accessibilityFocusedNode,
        focusableElements,
        truncationReasons,
      ),
    )

    // Find the focused element index
    if (accessibilityFocusedNode != null) {
      focusedIndex = findFocusedElementIndex(focusableElements, accessibilityFocusedNode)
    }

    return TraversalOrderResult(
      elements = focusableElements,
      focusedIndex = focusedIndex,
      truncationReasons = truncationReasons.toList().ifEmpty { null },
    )
  }

  /**
   * Extract traversal order from all windows. Returns an ordered list of accessibility-focusable
   * elements across all windows.
   */
  fun extractTraversalOrderFromAllWindows(
    windows: List<AccessibilityWindowInfo>,
    activeWindowRoot: AccessibilityNodeInfo?,
    screenDimensions: ScreenDimensions? = null,
  ): TraversalOrderResult {
    if (windows.isEmpty() && activeWindowRoot == null) {
      Log.w(TAG, "No windows available for traversal order extraction")
      return TraversalOrderResult(elements = emptyList(), focusedIndex = null)
    }

    // Find accessibility-focused node across all windows
    var accessibilityFocusedNode: AccessibilityNodeInfo? = null
    for (window in windows) {
      val rootNode = window.root ?: continue
      val focusedInWindow = rootNode.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
      if (focusedInWindow != null) {
        accessibilityFocusedNode = focusedInWindow
        break
      }
    }
    // Fallback to activeWindowRoot
    if (accessibilityFocusedNode == null && activeWindowRoot != null) {
      accessibilityFocusedNode =
        activeWindowRoot.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
    }

    val focusableElements = mutableListOf<UIElementInfo>()
    val truncationReasons = linkedSetOf<String>()
    var focusedIndex: Int? = null

    // Collect from each window, sorted by layer
    val sortedWindows = windows.sortedBy { it.layer }
    for (window in sortedWindows) {
      val rootNode = window.root ?: continue
      collectFocusableElements(
        rootNode,
        0,
        FocusTraversal(
          screenDimensions,
          accessibilityFocusedNode,
          focusableElements,
          truncationReasons,
        ),
      )
    }

    // Find the focused element index
    if (accessibilityFocusedNode != null) {
      focusedIndex = findFocusedElementIndex(focusableElements, accessibilityFocusedNode)
    }

    return TraversalOrderResult(
      elements = focusableElements,
      focusedIndex = focusedIndex,
      truncationReasons = truncationReasons.toList().ifEmpty { null },
    )
  }

  /**
   * Collect accessibility-focusable elements in depth-first traversal order. This matches
   * TalkBack's default traversal behavior.
   */
  private data class FocusTraversal(
    val screenDimensions: ScreenDimensions?,
    val accessibilityFocusedNode: AccessibilityNodeInfo?,
    val result: MutableList<UIElementInfo>,
    val truncationReasons: MutableSet<String>,
  )

  private fun collectFocusableElements(
    node: AccessibilityNodeInfo,
    depth: Int,
    context: FocusTraversal,
  ) {
    if (depth > MAX_DEPTH) {
      return
    }

    try {
      val bounds = Rect()
      node.getBoundsInScreen(bounds)
      val elementBounds = ElementBounds(bounds)

      // Filter zero-area and offscreen nodes
      if (elementBounds.hasZeroArea()) {
        return
      }

      if (context.screenDimensions != null && context.screenDimensions.isValid()) {
        if (
          elementBounds.isCompletelyOffscreen(
            context.screenDimensions.width,
            context.screenDimensions.height,
          )
        ) {
          return
        }
      }

      collectFocusableNode(node, context)
      collectFocusableChildren(node, depth, context)
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Error collecting focusable element at depth $depth", e)
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "Error collecting focusable element at depth $depth", e)
    } catch (e: SecurityException) {
      Log.w(TAG, "Error collecting focusable element at depth $depth", e)
    }
  }

  private fun collectFocusableNode(node: AccessibilityNodeInfo, context: FocusTraversal) {
    // Check if this node is accessibility-focusable
    // A node is focusable if it supports ACTION_ACCESSIBILITY_FOCUS or
    // ACTION_CLEAR_ACCESSIBILITY_FOCUS
    // The currently focused node typically has ACTION_CLEAR_ACCESSIBILITY_FOCUS instead
    val isFocusable =
      node.actionList?.any {
        it.id == AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS ||
          it.id == AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS
      } ?: false

    // Also include nodes that are currently accessibility focused
    val isCurrentlyFocused = node.isAccessibilityFocused

    if (isFocusable || isCurrentlyFocused) {
      // Extract element info for focusable elements
      val elementInfo = extractSimpleElementInfo(node, context.accessibilityFocusedNode)
      if (elementInfo != null) {
        context.result.add(elementInfo)
      }
    }
  }

  private fun collectFocusableChildren(
    node: AccessibilityNodeInfo,
    depth: Int,
    context: FocusTraversal,
  ) {
    // Recursively collect from children (depth-first traversal)
    val totalChildCount = node.childCount
    val childCount = min(totalChildCount, MAX_CHILDREN)
    if (totalChildCount > MAX_CHILDREN) {
      context.truncationReasons += "max_children"
    }
    for (i in 0 until childCount) {
      val child = node.getChild(i)
      if (child != null) {
        collectFocusableElements(
          child,
          depth + 1,
          context,
        )
        child.recycle()
      }
    }
  }

  /**
   * Extract simplified element info for traversal order. Only includes essential fields to reduce
   * payload size.
   */
  private fun extractSimpleElementInfo(
    node: AccessibilityNodeInfo,
    accessibilityFocusedNode: AccessibilityNodeInfo?,
  ): UIElementInfo? {
    return try {
      val bounds = Rect()
      node.getBoundsInScreen(bounds)
      val elementBounds = ElementBounds(bounds)

      val extrasMap = extractExtras(node)
      val testTag = extractTestTag(extrasMap)

      // Check if this node is the focused one
      val isAccessibilityFocusedBool =
        accessibilityFocusedNode != null && isSameNode(node, accessibilityFocusedNode)

      val rawText = node.text?.toString()
      val maskedText =
        if (rawText != null && node.isPassword) "•".repeat(rawText.length) else rawText
      UIElementInfo(
        className = node.className?.toString(),
        resourceId = node.viewIdResourceName,
        text = maskedText,
        contentDesc = node.contentDescription?.toString(),
        clickable = node.isClickable.toString(),
        enabled = node.isEnabled.toString(),
        focusable = node.isFocusable.toString(),
        accessibilityFocused = isAccessibilityFocusedBool.toString(),
        bounds = elementBounds,
        testTag = testTag,
      )
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Error extracting simple element info", e)
      null
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "Error extracting simple element info", e)
      null
    } catch (e: SecurityException) {
      Log.w(TAG, "Error extracting simple element info", e)
      null
    }
  }

  /**
   * Check if two AccessibilityNodeInfo objects refer to the same node. Compares bounds, resource
   * ID, and text.
   */
  private fun isSameNode(
    node1: AccessibilityNodeInfo,
    node2: AccessibilityNodeInfo,
  ): Boolean {
    try {
      val bounds1 = Rect()
      val bounds2 = Rect()
      node1.getBoundsInScreen(bounds1)
      node2.getBoundsInScreen(bounds2)

      return bounds1 == bounds2 &&
        node1.viewIdResourceName == node2.viewIdResourceName &&
        node1.text?.toString() == node2.text?.toString()
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Could not compare accessibility nodes", e)
      return false
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "Could not compare accessibility nodes", e)
      return false
    } catch (e: SecurityException) {
      Log.w(TAG, "Could not compare accessibility nodes", e)
      return false
    }
  }

  /** Find the index of the focused element in the focusable elements list. */
  private fun findFocusedElementIndex(
    focusableElements: List<UIElementInfo>,
    accessibilityFocusedNode: AccessibilityNodeInfo,
  ): Int? {
    val focusedBounds = Rect()
    accessibilityFocusedNode.getBoundsInScreen(focusedBounds)
    val focusedResourceId = accessibilityFocusedNode.viewIdResourceName
    val focusedText = accessibilityFocusedNode.text?.toString()

    return focusableElements
      .indexOfFirst { element ->
        val bounds = element.bounds
        bounds != null &&
          bounds.left == focusedBounds.left &&
          bounds.top == focusedBounds.top &&
          bounds.right == focusedBounds.right &&
          bounds.bottom == focusedBounds.bottom &&
          element.resourceId == focusedResourceId &&
          element.text == focusedText
      }
      .takeIf { it >= 0 }
  }
}
