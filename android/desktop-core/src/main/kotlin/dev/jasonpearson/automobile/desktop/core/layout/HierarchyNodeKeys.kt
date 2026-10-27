package dev.jasonpearson.automobile.desktop.core.layout

/**
 * The resolved [StructuralRole] for a node in role mode, threaded to children as their parent role;
 * null in class-name mode where roles are unused. Computed once per node so [pathKey] and the
 * recursion share the value (and the [structuralRoleOf] parent-context inference).
 */
internal fun roleFor(
  node: UIElementInfo,
  keyMode: DiffKeyMode,
  parentRole: StructuralRole?,
): StructuralRole? =
  if (keyMode == DiffKeyMode.StructuralRole) structuralRoleOf(node, parentRole) else null

internal fun pathKey(
  parentKey: String,
  node: UIElementInfo,
  siblingIndex: Int,
  keyMode: DiffKeyMode,
  role: StructuralRole?,
): String {
  val segment =
    when (keyMode) {
      DiffKeyMode.ClassName -> "${node.className}:${node.resourceId ?: ""}#$siblingIndex"
      // Role mode drops the platform-specific resourceId: it never matches across Android↔iOS, so
      // keeping it would defeat the whole point of role keying. [role] is the pre-resolved
      // [roleFor] value (non-null in this mode).
      DiffKeyMode.StructuralRole -> "${role}#$siblingIndex"
    }
  return if (parentKey.isEmpty()) segment else "$parentKey$PATH_SEPARATOR$segment"
}

/**
 * The cross-platform [StructuralRole] of a full node, given its [parentRole] (the resolved role of
 * its parent, or null at a window root). Starts from the class-name mapping, then applies the
 * semantic and positional signals a class name alone cannot carry:
 * - A checkable node is promoted to [StructuralRole.Checkbox] unless its class already keyed it to
 *   the sibling checkable role [StructuralRole.Switch]. The live iOS runner reports a checkbox as
 *   the bare `UIView` class (`ElementLocator.mapElementType` has no `.checkBox` case) while still
 *   setting `isCheckable`, so an iOS checkbox arrives as a generic Container; Android's
 *   `CheckedTextView` instead keys as [StructuralRole.Text] by class (it contains the `TextView`
 *   substring) yet is a standard checkable control. Promoting on `isCheckable` regardless of the
 *   class-derived role — not only the generic ones — pairs both against Android's `CheckBox`
 *   instead of leaving them as OnlyIn. `Switch` is exempt so a `UISwitch`/`SwitchCompat`/
 *   `ToggleButton` (also checkable) keeps its own distinct role (issue #4872 review).
 * - A generic node whose [parentRole] is [StructuralRole.List] is promoted to
 *   [StructuralRole.ListItem]: it is the list's row wrapper. iOS emits a row as a `UITableViewCell
 *   -> ListItem` by class, but an Android row is an ordinary `LinearLayout`/`ViewGroup ->
 *   Container` whose collection-item metadata `HierarchyParser` drops, so inferring `ListItem` from
 *   the `List` parent is what pairs the two rows (and thus their descendants) instead of leaving
 *   every row as OnlyIn (issue #4872 review).
 * - A non-interactive generic node that carries an accessible name is promoted to
 *   [StructuralRole.Text]. Android's `ViewHierarchyExtractor` blanks `android.widget.TextView` to a
 *   class-less node (it is in `GENERIC_CLASS_NAMES`), which `HierarchyParser` then defaults to
 *   `android.view.View` — so an ordinary Android label reaches here as a generic Container and
 *   would never pair with the iOS runner's `UILabel -> Text`, leaving ubiquitous labels and their
 *   whole subtrees as OnlyIn. The promotion recovers the label the producer erased. It is gated on
 *   non-empty accessible name and on the node being neither clickable nor scrollable, so a genuine
 *   interactive control or scroll container that merely happens to carry a label is left in its
 *   structural role (issue #4872 review).
 * - A generic scrollable node is promoted to [StructuralRole.ScrollView]. Android's extractor also
 *   clears `android.widget.ScrollView`, but retains `isScrollable`; without this recovery it
 *   remains a Container and cannot pair with iOS's `UIScrollView -> ScrollView` role.
 */
internal fun structuralRoleOf(node: UIElementInfo, parentRole: StructuralRole?): StructuralRole {
  val byClass = structuralRole(node.className)
  // Checkable controls key as Checkbox even when the class name mapped them elsewhere (e.g.
  // CheckedTextView -> Text), so a checkable control pairs across platforms. Switch is left alone:
  // it is a distinct checkable role that must not collapse into Checkbox.
  if (node.isCheckable && byClass != StructuralRole.Switch) return StructuralRole.Checkbox
  val isGeneric = byClass == StructuralRole.Container || byClass == StructuralRole.Other
  if (!isGeneric) return byClass
  if (parentRole == StructuralRole.List) return StructuralRole.ListItem
  if (node.isScrollable) return StructuralRole.ScrollView
  val hasAccessibleName = !accessibleName(node).isNullOrEmpty()
  if (hasAccessibleName && !node.isClickable && !node.isScrollable) return StructuralRole.Text
  return byClass
}

/**
 * Whether two same-key nodes differ in a compared semantic attribute. Bounds and children are
 * deliberately excluded (see [diffHierarchies]); className and resourceId are already equal because
 * they are part of the key.
 *
 * [keyMode] governs the label comparison. A same-platform diff ([DiffKeyMode.ClassName]) compares
 * `text` and `contentDescription` field-by-field, the honest identity where both platforms fill the
 * same fields. A cross-platform diff ([DiffKeyMode.StructuralRole]) compares a single normalized
 * [accessibleName] instead: Android puts an icon control's label in `content-desc` and a visible
 * label in `text`, whereas iOS puts every accessibility label in `text` and leaves `content-desc`
 * null — so comparing the fields separately reports equivalent controls (an Android
 * `content-desc="Add"` vs an iOS `text="Add"`) as Changed. The boolean state flags are compared
 * identically in both modes (issue #4872 review).
 */
internal fun nodeAttributesDiffer(
  a: UIElementInfo,
  b: UIElementInfo,
  keyMode: DiffKeyMode,
): Boolean {
  val labelsDiffer =
    when (keyMode) {
      DiffKeyMode.ClassName -> a.text != b.text || a.contentDescription != b.contentDescription
      DiffKeyMode.StructuralRole -> accessibleName(a) != accessibleName(b)
    }
  return labelsDiffer ||
    a.isClickable != b.isClickable ||
    a.isEnabled != b.isEnabled ||
    a.isFocused != b.isFocused ||
    a.isSelected != b.isSelected ||
    a.isScrollable != b.isScrollable ||
    a.isCheckable != b.isCheckable ||
    a.isChecked != b.isChecked
}

/**
 * The cross-platform accessible name of a node. Android's explicit content description is its
 * accessibility label even when visible text is also present; iOS serializes that label in `text`
 * and leaves `contentDescription` empty. Prefer the former when available, then fall back to text,
 * so a production Android label such as `content-desc="Predicted app: AutoMobile Playground"` pairs
 * with the equivalent iOS text instead of comparing the Android's separate visible label.
 */
internal fun accessibleName(node: UIElementInfo): String? =
  node.contentDescription?.takeIf { it.isNotEmpty() } ?: node.text?.takeIf { it.isNotEmpty() }
