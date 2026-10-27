package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy

/**
 * Computes a structural hash of the view hierarchy that ignores bounds.
 *
 * During scroll/fling animations, many TYPE_WINDOW_CONTENT_CHANGED events fire, but only the bounds
 * are changing (elements moving). The actual content (text, resource-ids, structure) remains the
 * same.
 *
 * By hashing only structural content, we can detect:
 * - Animation: Same hash = just bounds changing, no real content change
 * - Real change: Different hash = actual content/structure changed
 *
 * This allows us to skip unnecessary debounce waits during animations.
 */
object StructuralHasher {

  /** Compute a structural hash of the hierarchy, excluding bounds. */
  fun computeHash(hierarchy: ViewHierarchy): Int {
    var hash = 17
    hash = 31 * hash + (hierarchy.packageName?.hashCode() ?: 0)
    hierarchy.hierarchy?.let { root -> hash = 31 * hash + computeElementHash(root) }
    return hash
  }

  /** Compute hash for a single UIElementInfo, excluding bounds. */
  private fun computeElementHash(element: UIElementInfo): Int {
    var hash = 17

    // Text content fields
    hash = 31 * hash + element.text.hashCode()
    hash = 31 * hash + element.contentDesc.hashCode()
    hash = 31 * hash + element.resourceId.hashCode()
    hash = 31 * hash + element.className.hashCode()
    hash = 31 * hash + element.hintText.hashCode()
    hash = 31 * hash + element.errorMessage.hashCode()
    hash = 31 * hash + element.stateDescription.hashCode()
    hash = 31 * hash + element.paneTitle.hashCode()
    hash = 31 * hash + element.testTag.hashCode()
    hash = 31 * hash + element.role.hashCode()

    // Boolean state flags (as strings)
    hash = 31 * hash + element.clickable.hashCode()
    hash = 31 * hash + element.focusable.hashCode()
    hash = 31 * hash + element.scrollable.hashCode()
    hash = 31 * hash + element.checkable.hashCode()
    hash = 31 * hash + element.checked.hashCode()
    hash = 31 * hash + element.selected.hashCode()
    hash = 31 * hash + element.enabled.hashCode()
    hash = 31 * hash + element.focused.hashCode()
    hash = 31 * hash + element.longClickable.hashCode()
    hash = 31 * hash + element.password.hashCode()

    // Other semantic fields
    hash = 31 * hash + element.liveRegion.hashCode()
    hash = 31 * hash + element.collectionInfo.hashCode()
    hash = 31 * hash + element.collectionItemInfo.hashCode()
    hash = 31 * hash + element.rangeInfo.hashCode()
    hash = 31 * hash + element.inputType.hashCode()
    hash = 31 * hash + element.actions.hashCode()
    hash = 31 * hash + VolatileExtras.structuralHash(element.extras)
    hash = 31 * hash + element.fragment.hashCode()

    // NOTE: Intentionally EXCLUDING:
    // - bounds (changes during animation)
    // - accessible (z-index percentage may fluctuate)
    // - textSize/textColor (unlikely to change during animation, but not structural)

    // Recursively hash the typed children (issue #5471: no JSON decode needed).
    for (child in element.children) {
      hash = 31 * hash + computeElementHash(child)
    }

    return hash
  }
}
