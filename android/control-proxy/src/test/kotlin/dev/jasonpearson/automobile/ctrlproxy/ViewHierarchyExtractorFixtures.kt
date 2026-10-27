package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import kotlinx.serialization.json.Json
import org.junit.Before

internal abstract class ViewHierarchyExtractorFixtures {

  protected lateinit var extractor: ViewHierarchyExtractor
  protected val json = Json { ignoreUnknownKeys = true }

  @Before
  fun setUp() {
    extractor = ViewHierarchyExtractor()
  }

  protected data class NodeState(
    val bounds: Rect = Rect(0, 100, 1080, 200),
    val children: List<android.view.accessibility.AccessibilityNodeInfo> = emptyList(),
    val enabled: Boolean? = null,
    val visibleToUser: Boolean = true,
  )

  protected fun fakeNode(
    packageName: String,
    text: String? = null,
    resourceId: String? = null,
    state: NodeState = NodeState(),
  ): android.view.accessibility.AccessibilityNodeInfo {
    val node = android.view.accessibility.AccessibilityNodeInfo.obtain()
    node.packageName = packageName
    node.className = "android.widget.TextView"
    node.text = text
    node.viewIdResourceName = resourceId
    node.setBoundsInScreen(state.bounds)
    node.isVisibleToUser = state.visibleToUser
    state.enabled?.let { node.isEnabled = it }
    val shadow = org.robolectric.Shadows.shadowOf(node)
    for (child in state.children) {
      shadow.addChild(child)
    }
    // The extractor calls findFocus on each window root, which the framework only allows on a
    // sealed (service-delivered) node. setSealed is a hidden API, so seal via reflection after
    // the setters above (which in turn require an unsealed node).
    android.view.accessibility.AccessibilityNodeInfo::class
      .java
      .getMethod("setSealed", Boolean::class.javaPrimitiveType)
      .invoke(node, true)
    return node
  }

  protected data class WindowState(
    val type: Int = AccessibilityWindowInfo.TYPE_APPLICATION,
    val focused: Boolean = false,
    val active: Boolean = false,
    val bounds: Rect? = null,
    val title: CharSequence? = null,
    val accessibilityFocused: Boolean = false,
  )

  protected fun fakeWindow(
    id: Int,
    layer: Int,
    root: android.view.accessibility.AccessibilityNodeInfo?,
    state: WindowState = WindowState(),
  ): AccessibilityWindowInfo {
    val window = AccessibilityWindowInfo.obtain()
    val shadow = org.robolectric.Shadows.shadowOf(window)
    state.title?.let { shadow.setTitle(it) }
    shadow.setId(id)
    shadow.setLayer(layer)
    shadow.setType(state.type)
    shadow.setRoot(root)
    shadow.setFocused(state.focused)
    shadow.setActive(state.active)
    shadow.setAccessibilityFocused(state.accessibilityFocused)
    shadow.setBoundsInScreen(
      state.bounds
        ?: Rect(0, 0, 1080, if (state.type == AccessibilityWindowInfo.TYPE_SYSTEM) 63 else 2400),
    )
    return window
  }

  // Helper method to read the visible typed children of a hierarchy node (issue #5471).
  protected fun ViewHierarchyExtractor.extractChildrenFromHierarchy(
    element: UIElementInfo,
  ): List<UIElementInfo> = this.visibleChildren(element)

  protected data class ElementContent(
    val className: String? = null,
    val text: String? = null,
    val contentDesc: String? = null,
    val actions: List<String>? = null,
  )

  protected fun elementWithBounds(
    resourceId: String? = null,
    viewId: String? = resourceId,
    bounds: ElementBounds? = null,
    children: List<UIElementInfo> = emptyList(),
    content: ElementContent = ElementContent(),
  ): UIElementInfo {
    return UIElementInfo(
      resourceId = resourceId,
      viewId = viewId,
      bounds = bounds,
      className = content.className,
      text = content.text,
      contentDesc = content.contentDesc,
      actions = content.actions,
      children = children,
    )
  }

  protected fun bounds(left: Int, top: Int, right: Int, bottom: Int): ElementBounds {
    return ElementBounds(left, top, right, bottom)
  }

  protected fun findElementByResourceId(
    element: UIElementInfo,
    resourceId: String,
  ): UIElementInfo? {
    if (element.resourceId == resourceId) {
      return element
    }
    for (child in element.children) {
      val found = findElementByResourceId(child, resourceId)
      if (found != null) {
        return found
      }
    }
    return null
  }

  protected data class WindowDetails(
    val packageName: String? = null,
    val isActive: Boolean = true,
    val isFocused: Boolean = true,
    val windowBounds: ElementBounds? = null,
    val isOwnPrototype: Boolean = false,
  )

  protected fun ViewHierarchyExtractor.createWindowEntry(
    windowId: Int,
    windowLayer: Int,
    hierarchy: UIElementInfo,
    windowType: String = "application",
    details: WindowDetails = WindowDetails(),
  ): Any {
    val windowEntryClass = this.javaClass.declaredClasses.first { it.simpleName == "WindowEntry" }
    val constructor =
      windowEntryClass.getDeclaredConstructor(
        Int::class.javaPrimitiveType,
        String::class.java,
        Int::class.javaPrimitiveType,
        String::class.java,
        Boolean::class.javaPrimitiveType,
        Boolean::class.javaPrimitiveType,
        UIElementInfo::class.java,
        ElementBounds::class.java,
        Boolean::class.javaPrimitiveType,
      )
    constructor.isAccessible = true
    return constructor.newInstance(
      windowId,
      windowType,
      windowLayer,
      details.packageName,
      details.isActive,
      details.isFocused,
      hierarchy,
      details.windowBounds,
      details.isOwnPrototype,
    )
  }

  protected fun ViewHierarchyExtractor.buildOcclusionInfoForTest(
    windowEntries: List<Any>,
  ): Map<*, *> {
    val method = this.javaClass.getDeclaredMethod("buildOcclusionInfo", List::class.java)
    method.isAccessible = true
    return method.invoke(this, windowEntries) as Map<*, *>
  }

  protected fun ViewHierarchyExtractor.filterOccludedHierarchyForTest(
    element: UIElementInfo,
    occlusionInfo: Map<*, *>,
    windowKey: Int,
    path: String,
    isRoot: Boolean,
  ): UIElementInfo? {
    val method =
      this.javaClass.getDeclaredMethod(
        "filterOccludedHierarchy",
        UIElementInfo::class.java,
        Map::class.java,
        Int::class.javaPrimitiveType,
        String::class.java,
        Boolean::class.javaPrimitiveType,
      )
    method.isAccessible = true
    return method.invoke(this, element, occlusionInfo, windowKey, path, isRoot) as UIElementInfo?
  }
}
