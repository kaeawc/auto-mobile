package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.os.Build
import android.text.Spanned
import android.text.style.ClickableSpan
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ContentHiddenRegion
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SemanticLink
import dev.jasonpearson.automobile.ctrlproxy.models.TraversalOrderResult
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.models.WindowInfo
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/**
 * Component responsible for parsing AccessibilityNodeInfo trees and converting them into
 * UIElementInfo objects for automated testing.
 */
class ViewHierarchyExtractor(private val recompositionStore: RecompositionStore? = null) {

  companion object {
    private const val TAG = "ViewHierarchyExtractor"
    private const val MAX_DEPTH = 100 // Prevent infinite traversal in focus-order extraction
    private const val MAX_CHILDREN = 256 // Limit children to prevent memory issues
    private const val OCCLUSION_THRESHOLD = 0.95
    private const val DEFAULT_WINDOW_KEY = -1
    private const val CONTENT_HIDDEN_REASON_COMPOSE_INTEROP = "compose-interop-no-hide-descendants"
    private const val MIN_HIDDEN_REGION_SCREEN_AREA = 0.25
    private const val MAX_VISIBLE_CHILD_COVERAGE = 0.25

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
   * @param textFilter Optional text filter
   * @param screenDimensions Optional screen dimensions for offscreen filtering
   * @param dedupeTextContentDesc When true, omit content-desc when it equals text (default: true)
   * @param disableAllFiltering When true, disable all optimizations and filtering (for observe with
   *   raw:true)
   */
  @JvmOverloads
  fun extractFromActiveWindow(
    rootNode: AccessibilityNodeInfo?,
    textFilter: String? = null,
    screenDimensions: ScreenDimensions? = null,
    dedupeTextContentDesc: Boolean = true,
    disableAllFiltering: Boolean = false,
    snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
  ): ViewHierarchy? {
    if (rootNode == null) {
      Log.w(TAG, "Root node is null")
      return ViewHierarchy(error = "Root node is null")
    }

    return try {
      // Find accessibility-focused node before extracting hierarchy
      val accessibilityFocusedNode = rootNode.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)

      val budget = HierarchySnapshotBudget(snapshotOptions)
      val rootElement =
        extractNodeInfo(
          rootNode,
          0,
          textFilter,
          screenDimensions,
          dedupeTextContentDesc,
          accessibilityFocusedNode,
          budget = budget,
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

      val intentChooserDetected =
        processedElement?.let { detectIntentChooserIndicators(it) } ?: false
      val notificationPermissionDetected = processedElement?.let {
        detectNotificationPermissionDialog(it, rootNode.packageName?.toString())
      }

      val unifiedHierarchy = processedElement?.let { UIElementInfo(children = listOf(it)) }

      // Find the accessibility-focused element in the unified hierarchy
      val accessibilityFocusedElement = unifiedHierarchy?.let {
        findAccessibilityFocusedElement(it)
      }

      ViewHierarchy(
        packageName = rootNode.packageName?.toString(),
        hierarchy = unifiedHierarchy?.let { WireNodeCodec.materialize(it) },
        intentChooserDetected = intentChooserDetected,
        notificationPermissionDetected = notificationPermissionDetected,
        accessibilityFocusedElement =
          accessibilityFocusedElement?.let { WireNodeCodec.materialize(it) },
        contentHiddenRegions = contentHiddenRegions?.takeIf { it.isNotEmpty() },
        truncationReasons = budget.truncationReasons().ifEmpty { null },
      )
    } catch (e: Exception) {
      Log.e(TAG, "Error extracting view hierarchy", e)
      ViewHierarchy(error = "Failed to extract view hierarchy: ${e.message}")
    }
  }

  /**
   * Extracts view hierarchy from all visible windows. This captures popups, toolbars, and other
   * floating windows that aren't in the main window.
   *
   * @param windows List of all accessibility windows (from AccessibilityService.windows)
   * @param activeWindowRoot Root node of the active window (for backward compatibility)
   * @param textFilter Optional text filter
   * @param screenDimensions Optional screen dimensions for offscreen filtering
   * @param dedupeTextContentDesc When true, omit content-desc when it equals text (default: true)
   * @param disableAllFiltering When true, disable all optimizations and filtering (for observe with
   *   raw:true)
   * @param occlusionEnabled When false, skip the cross-window occlusion pass entirely — no occluder
   *   loop, no occlusionState/occludedBy/occludedByViewId fields (daemon's --no-occlusion flag,
   *   default true)
   */
  @JvmOverloads
  fun extractFromAllWindows(
    windows: List<AccessibilityWindowInfo>,
    activeWindowRoot: AccessibilityNodeInfo?,
    textFilter: String? = null,
    screenDimensions: ScreenDimensions? = null,
    dedupeTextContentDesc: Boolean = true,
    disableAllFiltering: Boolean = false,
    occlusionEnabled: Boolean = true,
    snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
  ): ViewHierarchy {
    if (windows.isEmpty() && activeWindowRoot == null) {
      Log.w(TAG, "No windows available for extraction")
      return ViewHierarchy(error = "No windows available")
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
    // Fallback to activeWindowRoot if not found in windows list
    if (accessibilityFocusedNode == null && activeWindowRoot != null) {
      accessibilityFocusedNode =
        activeWindowRoot.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
    }

    val windowEntries = mutableListOf<WindowEntry>()
    val budget = HierarchySnapshotBudget(snapshotOptions)
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
    var hasApplicationWindow = false

    // When an IME (keyboard) window is visible, Android marks the IME as isActive/isFocused.
    // Fall back to "topmost TYPE_APPLICATION window with a root" for mainHierarchy selection.
    val primaryAppWindowId: Int? = pickPrimaryAppWindowId(windows)

    // Extract from each window
    for (window in windows) {
      try {
        val rootNode = window.root
        if (rootNode == null) {
          if (window.isActive) {
            Log.w(
              TAG,
              "[HIERARCHY-DEBUG] Active window ${window.id} has null root node - accessibility service incomplete",
            )
            activeWindowHasNullRoot = true
          } else {
            Log.d(TAG, "[HIERARCHY-DEBUG] Window ${window.id} has null root node, skipping")
          }
          continue
        }
        val windowLayer = window.layer
        if (window.isActive) {
          activeWindowLayer = windowLayer
          activeWindowKey = window.id
        }

        val windowType =
          when (window.type) {
            AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
            AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "input_method"
            AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
            AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "accessibility_overlay"
            AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "split_screen_divider"
            AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY -> "magnification_overlay"
            else -> "unknown_${window.type}"
          }

        // Track if we successfully extract from any application window
        // Only TYPE_APPLICATION counts - IME, overlays, and system windows don't represent app
        // content
        if (window.type == AccessibilityWindowInfo.TYPE_APPLICATION) {
          hasApplicationWindow = true
        }

        val windowBounds = Rect()
        window.getBoundsInScreen(windowBounds)
        windowInfos.add(
          WindowInfo(
            id = window.id,
            type = window.type,
            isActive = window.isActive,
            isFocused = window.isFocused,
            bounds = ElementBounds(windowBounds),
          )
        )

        val element =
          extractNodeInfo(
            rootNode,
            0,
            textFilter,
            screenDimensions,
            dedupeTextContentDesc,
            accessibilityFocusedNode,
            parentPath = "w${window.id}",
            budget = budget,
          )
        if (element != null) {
          contentHiddenRegionRoots.add(element)
        }
        // Skip optimization if disableAllFiltering is true
        val processedElement =
          if (disableAllFiltering) {
            element
          } else {
            element?.let {
              val optimizedList = optimizeHierarchy(it)
              wrapOptimizedElements(optimizedList)
            }
          }
        val packageName = rootNode.packageName?.toString()
        if (!intentChooserDetected && processedElement != null) {
          intentChooserDetected = detectIntentChooserIndicators(processedElement)
        }

        // When IME is up, the IME reports isActive=true; prefer the app window underneath.
        val isPrimaryWindow =
          if (primaryAppWindowId != null) window.id == primaryAppWindowId else window.isActive
        if (isPrimaryWindow) {
          mainHierarchy = processedElement
          mainPackageName = packageName
          if (notificationPermissionDetected == null && processedElement != null) {
            notificationPermissionDetected =
              detectNotificationPermissionDialog(processedElement, packageName)
          }
        }

        if (processedElement != null) {
          windowEntries.add(
            WindowEntry(
              windowId = window.id,
              windowType = windowType,
              windowLayer = windowLayer,
              packageName = packageName,
              isActive = window.isActive,
              isFocused = window.isFocused,
              hierarchy = processedElement,
            )
          )
        }
      } catch (e: Exception) {
        Log.e(TAG, "Error extracting hierarchy from window ${window.id}", e)
      }
    }

    // Fallback to activeWindowRoot if no active window found in window list
    if (mainHierarchy == null && activeWindowRoot != null) {
      val element =
        extractNodeInfo(
          activeWindowRoot,
          0,
          textFilter,
          screenDimensions,
          dedupeTextContentDesc,
          accessibilityFocusedNode,
          budget = budget,
        )
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
      mainPackageName = activeWindowRoot.packageName?.toString()
      if (!intentChooserDetected && mainHierarchy != null) {
        intentChooserDetected = detectIntentChooserIndicators(mainHierarchy!!)
      }
      if (notificationPermissionDetected == null && mainHierarchy != null) {
        notificationPermissionDetected =
          detectNotificationPermissionDialog(mainHierarchy!!, mainPackageName)
      }
      if (mainHierarchy != null) {
        val fallbackWindowId = activeWindowKey ?: DEFAULT_WINDOW_KEY
        windowEntries.add(
          WindowEntry(
            windowId = fallbackWindowId,
            windowType = "application",
            windowLayer = activeWindowLayer,
            packageName = mainPackageName,
            isActive = true,
            isFocused = true,
            hierarchy = mainHierarchy!!,
          )
        )
      }
    }

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
      // Re-select main hierarchy after occlusion filtering. When IME is up, the IME entry is
      // the isActive one — use the primary app window id instead.
      mainHierarchy =
        windowEntries
          .firstOrNull {
            if (primaryAppWindowId != null) it.windowId == primaryAppWindowId else it.isActive
          }
          ?.hierarchy ?: mainHierarchy
    }

    if (windowEntries.isEmpty()) {
      Log.w(
        TAG,
        "[HIERARCHY-DEBUG] No visible windows available after filtering - marking as incomplete for fallback",
      )
      return ViewHierarchy(
        error = "No visible windows available",
        ctrlProxyIncomplete = true,
      )
    }

    val sortedWindowRoots =
      windowEntries
        .sortedWith(compareBy<WindowEntry> { it.windowLayer }.thenBy { it.windowId })
        .map { it.hierarchy }
    val unifiedHierarchy =
      if (sortedWindowRoots.isEmpty()) null else UIElementInfo(children = sortedWindowRoots)

    val accessibilityFocusedElement = unifiedHierarchy?.let { findAccessibilityFocusedElement(it) }

    // Determine if the accessibility service hierarchy is incomplete
    // This happens when:
    // 1. An active window has a null root (app restricts accessibility access)
    // 2. Only system UI windows were successfully extracted (no app windows accessible)
    val isSystemUiForeground = mainPackageName == "com.android.systemui"
    val ctrlProxyIncomplete =
      activeWindowHasNullRoot || (!hasApplicationWindow && !isSystemUiForeground)
    if (ctrlProxyIncomplete) {
      Log.w(
        TAG,
        "[HIERARCHY-DEBUG] Accessibility service incomplete: activeWindowHasNullRoot=$activeWindowHasNullRoot, hasApplicationWindow=$hasApplicationWindow",
      )
    }

    return ViewHierarchy(
      packageName = mainPackageName,
      hierarchy = unifiedHierarchy?.let { WireNodeCodec.materialize(it) },
      windows = windowInfos.takeIf { it.isNotEmpty() },
      intentChooserDetected = intentChooserDetected,
      notificationPermissionDetected = notificationPermissionDetected,
      accessibilityFocusedElement =
        accessibilityFocusedElement?.let { WireNodeCodec.materialize(it) },
      ctrlProxyIncomplete = if (ctrlProxyIncomplete) true else null,
      contentHiddenRegions = detectContentHiddenRegions(contentHiddenRegionRoots, screenDimensions),
      truncationReasons = budget.truncationReasons().ifEmpty { null },
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
          )
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

      for (child in visibleChildren(node)) {
        visit(child)
        if (hasNotificationText && hasPermissionButtons) {
          return
        }
      }
    }

    visit(element)
    return hasNotificationText && hasPermissionButtons
  }

  internal fun detectNotificationPermissionDialogForTest(
    element: UIElementInfo,
    packageName: String?,
  ): Boolean {
    return detectNotificationPermissionDialog(element, packageName)
  }

  /**
   * Selects the window id that hierarchy extraction should treat as the "primary" user-facing
   * window when an IME is visible. Returns null when no IME with a root is present (callers should
   * fall back to `window.isActive`).
   *
   * Android marks the IME's [AccessibilityWindowInfo.isActive] as true while the keyboard is
   * showing, which would otherwise cause `mainHierarchy` selection to pick the keyboard instead of
   * the app underneath it.
   */
  private fun pickPrimaryAppWindowId(windows: List<AccessibilityWindowInfo>): Int? =
    pickPrimaryAppWindowId(
      windows.map {
        WindowMeta(id = it.id, type = it.type, layer = it.layer, hasRoot = it.root != null)
      }
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
  )

  /** Single-pass variant used by tests and by the production overload. */
  internal fun pickPrimaryAppWindowId(windows: List<WindowMeta>): Int? {
    var hasIme = false
    var topAppId: Int? = null
    var topAppLayer = Int.MIN_VALUE
    for (w in windows) {
      if (!w.hasRoot) continue
      when (w.type) {
        AccessibilityWindowInfo.TYPE_INPUT_METHOD -> hasIme = true
        AccessibilityWindowInfo.TYPE_APPLICATION ->
          if (w.layer > topAppLayer) {
            topAppLayer = w.layer
            topAppId = w.id
          }
      }
    }
    return if (hasIme) topAppId else null
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
  private fun extractNodeInfo(
    node: AccessibilityNodeInfo,
    depth: Int,
    textFilter: String? = null,
    screenDimensions: ScreenDimensions? = null,
    dedupeTextContentDesc: Boolean = true,
    accessibilityFocusedNode: AccessibilityNodeInfo? = null,
    parentPath: String = "",
    childIndex: Int = 0,
    budget: HierarchySnapshotBudget,
  ): UIElementInfo? {
    if (!budget.enter(depth)) {
      return null
    }

    return try {
      val bounds = Rect()
      node.getBoundsInScreen(bounds)
      val elementBounds = ElementBounds(bounds)

      // Filter zero-area bounds early
      if (elementBounds.hasZeroArea()) {
        return null
      }

      // Filter completely offscreen nodes early to avoid processing subtrees
      if (screenDimensions != null && screenDimensions.isValid()) {
        if (elementBounds.isCompletelyOffscreen(screenDimensions.width, screenDimensions.height)) {
          return null
        }
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
      val childCount = min(node.childCount, MAX_CHILDREN)

      for (i in 0 until childCount) {
        val child = node.getChild(i)
        if (child != null) {
          val childInfo =
            extractNodeInfo(
              child,
              depth + 1,
              textFilter,
              screenDimensions,
              dedupeTextContentDesc,
              accessibilityFocusedNode,
              parentPath = currentPath,
              childIndex = i,
              budget = budget,
            )
          if (childInfo != null) {
            children.add(childInfo)
          }
        }
      }

      // Extract extra semantics fields
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
      if (Build.VERSION.SDK_INT >= 28) {
        tooltipText = node.tooltipText?.toString()
        paneTitle = node.paneTitle?.toString()
      }
      val apiGatedFields =
        apiGatedNodeFields(
          Build.VERSION.SDK_INT,
          uniqueId = if (Build.VERSION.SDK_INT >= 33) node.uniqueId else null,
          containerTitle =
            if (Build.VERSION.SDK_INT >= 34) node.containerTitle?.toString() else null,
        )

      // Extract accessibility actions
      val actionList = node.actionList
      if (actionList != null && actionList.isNotEmpty()) {
        actions = actionList.mapNotNull { action ->
          when (action.id) {
            AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS -> "accessibility_focus"
            AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS -> "clear_accessibility_focus"
            AccessibilityNodeInfo.ACTION_CLEAR_FOCUS -> "clear_focus"
            AccessibilityNodeInfo.ACTION_CLEAR_SELECTION -> "clear_selection"
            AccessibilityNodeInfo.ACTION_CLICK -> "click"
            AccessibilityNodeInfo.ACTION_COLLAPSE -> "collapse"
            AccessibilityNodeInfo.ACTION_COPY -> "copy"
            AccessibilityNodeInfo.ACTION_CUT -> "cut"
            AccessibilityNodeInfo.ACTION_DISMISS -> "dismiss"
            AccessibilityNodeInfo.ACTION_EXPAND -> "expand"
            AccessibilityNodeInfo.ACTION_FOCUS -> "focus"
            AccessibilityNodeInfo.ACTION_LONG_CLICK -> "long_click"
            AccessibilityNodeInfo.ACTION_NEXT_AT_MOVEMENT_GRANULARITY ->
              "next_at_movement_granularity"
            AccessibilityNodeInfo.ACTION_NEXT_HTML_ELEMENT -> "next_html_element"
            AccessibilityNodeInfo.ACTION_PASTE -> "paste"
            AccessibilityNodeInfo.ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY ->
              "previous_at_movement_granularity"
            AccessibilityNodeInfo.ACTION_PREVIOUS_HTML_ELEMENT -> "previous_html_element"
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> "scroll_backward"
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> "scroll_forward"
            AccessibilityNodeInfo.ACTION_SELECT -> "select"
            AccessibilityNodeInfo.ACTION_SET_SELECTION -> "set_selection"
            AccessibilityNodeInfo.ACTION_SET_TEXT -> "set_text"
            else -> null
          }
        }

        if (actions.isEmpty()) {
          actions = null
        }
      }

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

      val inputTypeInt = node.inputType
      if (inputTypeInt != 0) {
        inputType =
          when (inputTypeInt) {
            android.text.InputType.TYPE_CLASS_TEXT -> "text"
            android.text.InputType.TYPE_CLASS_NUMBER -> "number"
            android.text.InputType.TYPE_CLASS_PHONE -> "phone"
            android.text.InputType.TYPE_CLASS_DATETIME -> "datetime"
            android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS -> "email_address"
            android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_SUBJECT -> "email_subject"
            android.text.InputType.TYPE_TEXT_VARIATION_FILTER -> "filter"
            android.text.InputType.TYPE_TEXT_VARIATION_LONG_MESSAGE -> "long_message"
            android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD -> "password"
            android.text.InputType.TYPE_TEXT_VARIATION_PERSON_NAME -> "person_name"
            android.text.InputType.TYPE_TEXT_VARIATION_PHONETIC -> "phonetic"
            android.text.InputType.TYPE_TEXT_VARIATION_POSTAL_ADDRESS -> "postal_address"
            android.text.InputType.TYPE_TEXT_VARIATION_SHORT_MESSAGE -> "short_message"
            android.text.InputType.TYPE_TEXT_VARIATION_URI -> "uri"
            android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD -> "visible_password"
            android.text.InputType.TYPE_TEXT_VARIATION_WEB_EDIT_TEXT -> "web_edit_text"
            android.text.InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS -> "web_email_address"
            android.text.InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD -> "web_password"
            else -> null
          }
      }

      val liveRegionMode = node.liveRegion
      if (liveRegionMode != 0) {
        liveRegion =
          when (liveRegionMode) {
            1 -> "polite"
            2 -> "assertive"
            else -> "live_region_$liveRegionMode"
          }
      }

      val className =
        if (node.className.isNullOrBlank() || GENERIC_CLASS_NAMES.contains(node.className)) {
          null
        } else {
          node.className?.toString()
        }

      node.text?.toString()?.let {
        // Mask password content to avoid leaking secrets through the hierarchy.
        // Mirrors iOS UIElementInfo.value masking for .secureTextField.
        text = if (node.isPassword) "•".repeat(it.length) else it
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          textSize = node.extraRenderingInfo?.textSizeInPx
        }
        textColor = null // Remove the getTextColorHex(node) call
      }

      // Dedupe content-desc when it equals text (keep text, omit content-desc)
      val rawContentDesc = node.contentDescription?.toString()
      val contentDesc =
        if (dedupeTextContentDesc && rawContentDesc == text) {
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

      // Check if this node has accessibility focus
      val hasAccessibilityFocus =
        accessibilityFocusedNode != null && node == accessibilityFocusedNode

      // Generate viewId: use resourceId if available, otherwise deterministic UUID from path
      val viewId = node.viewIdResourceName ?: generateDeterministicUuid(currentPath)

      val elementInfo =
        UIElementInfo(
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
          checked = if (node.isChecked) "true" else null,
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

      if (childCount == 0 && !meetsFilterCriteria(elementInfo, textFilter)) {
        null
      } else {
        elementInfo
      }
    } catch (e: Exception) {
      Log.e(TAG, "Error extracting node info at depth $depth", e)
      null
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
    val occurrences = mutableMapOf<String, Int>()
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
          // Activation matches span text case-insensitively, so discovery must
          // use the same equivalence relation for occurrence numbering.
          val occurrenceKey = visibleText.lowercase(Locale.ROOT)
          val occurrence = occurrences[occurrenceKey] ?: 0
          occurrences[occurrenceKey] = occurrence + 1
          SemanticLink(visibleText, occurrence, start, end)
        }
    return links.ifEmpty { null }
  }

  /**
   * Generate a deterministic UUID from a hierarchy path string. Uses SHA-256 to hash the path and
   * formats the first 16 bytes as a UUID string.
   *
   * NOTE (#3228): this id is *positional* — a list scroll shifts child indices, so a moved row gets
   * a different UUID and the row now occupying its old slot inherits the departed row's. The
   * daemon's TS ingest (`StableNodeIdentity.assignStableViewIds`) therefore rewrites every
   * UUID-shaped viewId into a content-derived stable id before the hierarchy reaches consumers.
   * Keep the UUID shape here (8-4-4-4-12 lowercase hex): it is the marker the ingest matches;
   * emitting a different shape would make ids pass through unrewritten.
   */
  private fun generateDeterministicUuid(path: String): String {
    val bytes = java.security.MessageDigest.getInstance("SHA-256").digest(path.toByteArray())
    val hex = bytes.take(16).joinToString("") { "%02x".format(it) }
    return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}"
  }

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

    val map = mutableMapOf<String, String>()
    for (key in keys) {
      val value = extras.get(key)
      if (value != null) {
        map[key] = value.toString()
      }
    }
    return if (map.isEmpty()) null else map
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

    // Boolean filter criteria
    val hasBooleanCriteria =
      element.clickable == "true" ||
        element.scrollable == "true" ||
        element.focusable == "true" ||
        element.focused == "true" ||
        element.checkable == "true" ||
        element.checked == "true" ||
        element.selected == "true" ||
        element.longClickable == "true"

    // Accessibility feature criteria
    val hasAccessibilityFeatures =
      !element.liveRegion.isNullOrBlank() ||
        !element.collectionInfo.isNullOrBlank() ||
        !element.collectionItemInfo.isNullOrBlank() ||
        !element.rangeInfo.isNullOrBlank() ||
        !element.inputType.isNullOrBlank() ||
        !element.actions.isNullOrEmpty() ||
        !element.extras.isNullOrEmpty()

    // Apply text filter if provided
    val meetsTextFilter =
      textFilter?.let { filter -> element.text?.contains(filter, true) ?: false } ?: true

    return (hasStringCriteria || hasBooleanCriteria || hasAccessibilityFeatures) && meetsTextFilter
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
  private fun optimizeHierarchy(element: UIElementInfo): List<UIElementInfo> {
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
        Log.d(TAG, "[OPT] -> FILTER OUT (bounds-only, no children)")
        return emptyList()
      }
      Log.d(TAG, "[OPT] -> PROMOTE ${optimizedChildren.size} children")
      return optimizedChildren
    }

    Log.d(TAG, "[OPT] -> KEEP (meets criteria or interactive)")
    return listOf(element.copy(children = optimizedChildren))
  }

  private data class WindowEntry(
    val windowId: Int,
    val windowType: String,
    val windowLayer: Int,
    val packageName: String?,
    val isActive: Boolean,
    val isFocused: Boolean,
    val hierarchy: UIElementInfo,
  )

  private data class OrderCounter(var value: Int = 0)

  private data class NodeKey(val windowKey: Int, val path: String)

  private data class OcclusionNode(
    val key: NodeKey,
    val element: UIElementInfo,
    val bounds: ElementBounds,
    val windowLayer: Int,
    val windowKey: Int,
    val order: Int,
    val subtreeEnd: Int,
  )

  private data class OcclusionInfo(
    val coverage: Double,
    val occludedBy: String?,
    val occludedByViewId: String?,
  )

  /** Represents the relationship between two nodes in a tree hierarchy. */
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

  private fun buildOcclusionInfo(windowEntries: List<WindowEntry>): Map<NodeKey, OcclusionInfo> {
    val nodes = mutableListOf<OcclusionNode>()
    val imeWindowKeys =
      windowEntries
        .asSequence()
        .filter { it.windowType == "input_method" }
        .mapTo(mutableSetOf()) {
          it.windowId
        }
    for (windowEntry in windowEntries) {
      val hierarchy = windowEntry.hierarchy
      val windowKey = windowEntry.windowId
      val windowLayer = windowEntry.windowLayer
      collectOcclusionNodes(
        hierarchy,
        windowKey,
        windowLayer,
        path = "",
        orderCounter = OrderCounter(),
        nodes = nodes,
      )
    }

    if (nodes.isEmpty()) {
      return emptyMap()
    }

    val sortedNodes =
      nodes.sortedWith(compareBy<OcclusionNode> { it.windowLayer }.thenBy { it.order })
    val occlusionInfo = mutableMapOf<NodeKey, OcclusionInfo>()

    for (i in sortedNodes.indices) {
      val node = sortedNodes[i]
      val totalArea = node.bounds.width * node.bounds.height
      if (totalArea <= 0) continue

      val intersections = mutableListOf<ElementBounds>()
      var maxOverlap = 0
      var occludedBy: String? = null
      var occludedByViewId: String? = null

      // Debug: Track occlusion for text nodes
      val isDebugNode = node.element.text == "Tap" || node.element.text == "Discover"
      if (isDebugNode) {
        Log.d(
          TAG,
          "[OCCLUSION] Node text='${node.element.text}', bounds=${node.bounds}, path='${node.key.path}', order=${node.order}, subtreeEnd=${node.subtreeEnd}",
        )
      }

      for (j in i + 1 until sortedNodes.size) {
        val occluder = sortedNodes[j]
        // Skip cross-window IME occluders: the IME's a11y root has a transparent wrapper that
        // overstates the keyboard rectangle and would falsely mark the app underneath as hidden.
        // Same-window IME-vs-IME occlusion is preserved by the `windowKey != node.windowKey` guard.
        if (occluder.windowKey != node.windowKey && occluder.windowKey in imeWindowKeys) {
          continue
        }
        if (occluder.windowKey == node.windowKey) {
          // Within the same window, nodes should never occlude each other.
          // After optimizeHierarchy promotes children of bounds-only wrappers, the tree structure
          // no longer reliably reflects visual relationships. Nodes that are visual siblings
          // (e.g., a toolbar and a scrollable content area in a Compose Box) can end up at
          // different depths in the optimized tree, causing determineNodeRelationship to
          // incorrectly classify them as UNRELATED — leading to false occlusion (the Slack
          // channel-header disappearance bug).
          // This also makes the multi-window path consistent with the `windowEntries.size == 1`
          // guard above, which already skips within-window occlusion when only one window exists.
          if (isDebugNode) {
            Log.d(
              TAG,
              "[OCCLUSION]   Skip same-window: text='${occluder.element.text}', bounds=${occluder.bounds}, order=${occluder.order}",
            )
          }
          continue
        }

        val intersection = intersectBounds(node.bounds, occluder.bounds) ?: continue
        val overlapArea = intersection.width * intersection.height
        if (overlapArea <= 0) continue

        if (isDebugNode) {
          Log.d(
            TAG,
            "[OCCLUSION]   Occluder: text='${occluder.element.text}', bounds=${occluder.bounds}, overlap=$overlapArea, order=${occluder.order}",
          )
        }

        intersections.add(intersection)

        if (overlapArea > maxOverlap) {
          maxOverlap = overlapArea
          occludedBy = resolveOccluderLabel(occluder)
          occludedByViewId =
            resolveViewIdForOcclusionNode(
              occluder.element,
              occluder.key.windowKey,
              occluder.key.path,
            )
        }
      }

      if (intersections.isNotEmpty()) {
        val coveredArea =
          calculateUnionArea(intersections, maxArea = (totalArea * OCCLUSION_THRESHOLD).toInt())
        val coverage = coveredArea.toDouble() / totalArea.toDouble()
        if (isDebugNode) {
          Log.d(
            TAG,
            "[OCCLUSION]   Result: coverage=$coverage (${(coverage*100).toInt()}%), threshold=$OCCLUSION_THRESHOLD, coveredArea=$coveredArea, totalArea=$totalArea",
          )
        }
        if (coverage > 0.0) {
          occlusionInfo[node.key] =
            OcclusionInfo(
              coverage = coverage,
              occludedBy = occludedBy,
              occludedByViewId = occludedByViewId,
            )
        }
      }
    }

    return occlusionInfo
  }

  private fun collectOcclusionNodes(
    element: UIElementInfo,
    windowKey: Int,
    windowLayer: Int,
    path: String,
    orderCounter: OrderCounter,
    nodes: MutableList<OcclusionNode>,
  ): Int {
    val start = orderCounter.value++
    var end = start
    val children = element.children

    for ((index, child) in children.withIndex()) {
      val childPath = if (path.isBlank()) index.toString() else "$path.$index"
      val childEnd =
        collectOcclusionNodes(child, windowKey, windowLayer, childPath, orderCounter, nodes)
      end = max(end, childEnd)
    }

    val bounds = element.bounds
    if (bounds != null && !bounds.hasZeroArea()) {
      nodes.add(
        OcclusionNode(
          key = NodeKey(windowKey, path),
          element = element,
          bounds = bounds,
          windowLayer = windowLayer,
          windowKey = windowKey,
          order = start,
          subtreeEnd = end,
        )
      )
    }

    return end
  }

  private fun filterOccludedHierarchy(
    element: UIElementInfo,
    occlusionInfo: Map<NodeKey, OcclusionInfo>,
    windowKey: Int,
    path: String,
    isRoot: Boolean,
  ): UIElementInfo? {
    val key = NodeKey(windowKey, path)
    val info = occlusionInfo[key]
    val occlusionState =
      when {
        info == null -> null
        info.coverage >= OCCLUSION_THRESHOLD -> "hidden"
        info.coverage > 0.0 -> "partial"
        else -> null
      }

    // Debug logging for Tab text nodes
    if (element.text == "Tap" || element.text == "Discover") {
      Log.d(
        TAG,
        "[FILTER] text='${element.text}', path='$path', state=$occlusionState, coverage=${info?.coverage}, occludedBy='${info?.occludedBy}'",
      )
    }

    val filteredChildren =
      element.children.mapIndexedNotNull { index, child ->
        val childPath = if (path.isBlank()) index.toString() else "$path.$index"
        filterOccludedHierarchy(child, occlusionInfo, windowKey, childPath, isRoot = false)
      }

    if (occlusionState == "hidden" && !isRoot) {
      if (element.text == "Tap" || element.text == "Discover") {
        Log.d(TAG, "[FILTER] -> REMOVED text='${element.text}'")
      }
      return null
    }

    return element.copy(
      viewId = resolveViewIdForOcclusionNode(element, windowKey, path),
      children = filteredChildren,
      occlusionState = occlusionState,
      occludedBy = info?.occludedBy,
      occludedByViewId = info?.occludedByViewId,
    )
  }

  private fun intersectBounds(bounds: ElementBounds, other: ElementBounds): ElementBounds? {
    val left = max(bounds.left, other.left)
    val top = max(bounds.top, other.top)
    val right = min(bounds.right, other.right)
    val bottom = min(bounds.bottom, other.bottom)

    if (left >= right || top >= bottom) {
      return null
    }

    return ElementBounds(left, top, right, bottom)
  }

  private fun calculateUnionArea(rectangles: List<ElementBounds>, maxArea: Int? = null): Int {
    data class Event(val x: Int, val y1: Int, val y2: Int, val delta: Int)

    val events =
      rectangles
        .flatMap { rect ->
          listOf(
            Event(rect.left, rect.top, rect.bottom, 1),
            Event(rect.right, rect.top, rect.bottom, -1),
          )
        }
        .sortedBy { it.x }

    if (events.isEmpty()) return 0

    val activeIntervals = mutableListOf<Pair<Int, Int>>()
    var previousX = events.first().x
    var area = 0

    fun activeUnionLength(): Int {
      if (activeIntervals.isEmpty()) return 0
      val sorted = activeIntervals.sortedBy { it.first }
      var total = 0
      var currentStart = sorted[0].first
      var currentEnd = sorted[0].second

      for (i in 1 until sorted.size) {
        val (start, end) = sorted[i]
        if (start > currentEnd) {
          total += currentEnd - currentStart
          currentStart = start
          currentEnd = end
        } else {
          currentEnd = max(currentEnd, end)
        }
      }
      total += currentEnd - currentStart
      return total
    }

    for (event in events) {
      val dx = event.x - previousX
      if (dx > 0 && activeIntervals.isNotEmpty()) {
        val unionLength = activeUnionLength()
        area += unionLength * dx
        if (maxArea != null && area >= maxArea) {
          return area
        }
      }

      if (event.delta > 0) {
        activeIntervals.add(event.y1 to event.y2)
      } else {
        val index = activeIntervals.indexOfFirst { it.first == event.y1 && it.second == event.y2 }
        if (index >= 0) {
          activeIntervals.removeAt(index)
        }
      }

      previousX = event.x
    }

    return area
  }

  private fun resolveOccluderLabel(occluder: OcclusionNode): String {
    val element = occluder.element
    return element.resourceId?.takeIf { it.isNotBlank() }
      ?: element.contentDesc?.takeIf { it.isNotBlank() }
      ?: element.text?.takeIf { it.isNotBlank() }
      ?: element.className?.takeIf { it.isNotBlank() }
      ?: "unlabeled view"
  }

  private fun resolveViewIdForOcclusionNode(
    element: UIElementInfo,
    windowKey: Int,
    path: String,
  ): String {
    return element.viewId?.takeIf { it.isNotBlank() }
      ?: generateDeterministicUuid("occlusion/window:$windowKey/path:$path")
  }

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
    } catch (e: Exception) {
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
    var focusedIndex: Int? = null

    collectFocusableElements(
      rootNode,
      0,
      screenDimensions,
      accessibilityFocusedNode,
      focusableElements,
    )

    // Find the focused element index
    if (accessibilityFocusedNode != null) {
      focusedIndex = findFocusedElementIndex(focusableElements, accessibilityFocusedNode)
    }

    return TraversalOrderResult(
      elements = focusableElements,
      focusedIndex = focusedIndex,
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
    var focusedIndex: Int? = null

    // Collect from each window, sorted by layer
    val sortedWindows = windows.sortedBy { it.layer }
    for (window in sortedWindows) {
      val rootNode = window.root ?: continue
      collectFocusableElements(
        rootNode,
        0,
        screenDimensions,
        accessibilityFocusedNode,
        focusableElements,
      )
    }

    // Find the focused element index
    if (accessibilityFocusedNode != null) {
      focusedIndex = findFocusedElementIndex(focusableElements, accessibilityFocusedNode)
    }

    return TraversalOrderResult(
      elements = focusableElements,
      focusedIndex = focusedIndex,
    )
  }

  /**
   * Collect accessibility-focusable elements in depth-first traversal order. This matches
   * TalkBack's default traversal behavior.
   */
  private fun collectFocusableElements(
    node: AccessibilityNodeInfo,
    depth: Int,
    screenDimensions: ScreenDimensions?,
    accessibilityFocusedNode: AccessibilityNodeInfo?,
    result: MutableList<UIElementInfo>,
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

      if (screenDimensions != null && screenDimensions.isValid()) {
        if (elementBounds.isCompletelyOffscreen(screenDimensions.width, screenDimensions.height)) {
          return
        }
      }

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
        val elementInfo = extractSimpleElementInfo(node, accessibilityFocusedNode)
        if (elementInfo != null) {
          result.add(elementInfo)
        }
      }

      // Recursively collect from children (depth-first traversal)
      val childCount = min(node.childCount, MAX_CHILDREN)
      for (i in 0 until childCount) {
        val child = node.getChild(i)
        if (child != null) {
          collectFocusableElements(
            child,
            depth + 1,
            screenDimensions,
            accessibilityFocusedNode,
            result,
          )
          child.recycle()
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "Error collecting focusable element at depth $depth", e)
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
    } catch (e: Exception) {
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
    } catch (e: Exception) {
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
