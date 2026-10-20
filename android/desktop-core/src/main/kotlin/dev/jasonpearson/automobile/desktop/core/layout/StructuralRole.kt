package dev.jasonpearson.automobile.desktop.core.layout

/**
 * A cross-platform, structural role for a UI node, abstracting away the platform-specific
 * `className`. The role captures *what kind of thing* a node is (a button, a text label, a
 * scrollable list, …) so an Android and an iOS rendering of the same screen can be diffed by role
 * instead of by raw class (issue #4872).
 *
 * The set is deliberately coarse — it covers the widget families a two-device compare cares about
 * and folds everything unrecognised into [Other]. Grow it when a real screen needs a finer role,
 * not ahead of need.
 */
enum class StructuralRole {
  Container,
  Text,
  TextField,
  Button,
  Image,
  List,
  ListItem,
  Checkbox,
  Switch,
  Toolbar,
  ScrollView,
  Progress,
  WebView,
  Other,
}

/**
 * Map a platform-specific view `className` to its cross-platform [StructuralRole].
 *
 * Recognises both Android class names (`android.widget.*`, `androidx.*`, Compose, custom
 * `*View`/`*Layout` classes) and the iOS vocabulary. On iOS the class the runner reports is the
 * UIKit class name that `ElementLocator.mapElementType` emits (`XCUIApplication`, `UIWindow`,
 * `UIButton`, `UILabel`, `UITextField`, `UITableView`, `UITableViewCell`, `WKWebView`, `UIView`,
 * …), which `CtrlProxyHierarchy.convertNode` forwards unchanged — so the UIKit names are the ones
 * that must match on live trees. The XCUITest-native `XCUIElementType*` names are also recognised
 * defensively (they are what a raw XCUITest snapshot uses). Matching is by substring so
 * vendor-prefixed or `Compat`/`Material` variants (e.g. `SwitchCompat`, `MaterialButton`,
 * `AppCompatImageView`) fall into the right role without an exhaustive table.
 *
 * Order matters: more specific families are tested before broader ones. In particular toggles,
 * checkboxes, and radio buttons are matched before [Button] because Android's
 * `ToggleButton`/`CompoundButton`/`RadioButton` contain the substring `Button`; a list cell is
 * matched before [List] because `UITableViewCell` contains `TableView`; and iOS's editable
 * `UITextView` is matched before static [Text] because it contains `TextView` (Android's static
 * label). Unrecognised classes map to [Other].
 */
fun structuralRole(className: String): StructuralRole {
  val listRole = structuralListRole(className)
  return when {
    // Editable text entry. Android EditText; iOS UITextField/UISecureTextField/UISearchBar and the
    // editable UITextView (matched explicitly here — before the static Text branch — so it is not
    // mistaken for Android's static TextView); plus the XCUITest-native equivalents.
    listOf(
        "EditText",
        "TextField",
        "SearchField",
        "SearchBar",
        "UITextView",
        "XCUIElementTypeTextView",
      )
      .any(className::contains) -> StructuralRole.TextField
    // Checkboxes, radio buttons, and toggles/switches — before Button, since
    // ToggleButton/CompoundButton/RadioButton all contain the "Button" substring. Android's
    // RadioButton folds into Checkbox: the iOS runner reports a radio as a checkable `UIView` with
    // no distinct class, which structuralRoleOf promotes to Checkbox, so a shared checkable role is
    // the only one that pairs the two (issue #4872 review).
    listOf("CheckBox", "XCUIElementTypeCheckBox", "RadioButton").any(className::contains) ->
      StructuralRole.Checkbox
    // "Switch" also matches iOS UISwitch and XCUIElementTypeSwitch.
    listOf("Switch", "ToggleButton", "XCUIElementTypeToggle").any(className::contains) ->
      StructuralRole.Switch
    // Buttons: Android Button/ImageButton/MaterialButton, iOS UIButton / XCUIElementTypeButton.
    listOf("Button", "XCUIElementTypeButton").any(className::contains) -> StructuralRole.Button
    // Static text labels: Android TextView, iOS UILabel / XCUIElementTypeStaticText.
    listOf("TextView", "UILabel", "XCUIElementTypeStaticText").any(className::contains) ->
      StructuralRole.Text
    // Images: Android ImageView, iOS UIImageView / XCUIElementTypeImage.
    listOf("ImageView", "XCUIElementTypeImage").any(className::contains) -> StructuralRole.Image
    // A single row/cell within a list — before List, since UITableViewCell contains "TableView".
    // Catches iOS UITableViewCell/UICollectionViewCell and XCUIElementTypeCell.
    listRole != null -> listRole
    // Top/bottom chrome: toolbars, action/nav bars, tab bars. Android Toolbar/ActionBar; iOS
    // UIToolbar/UINavigationBar/UITabBar and the XCUITest-native equivalents (all covered by the
    // "Toolbar"/"NavigationBar"/"TabBar" substrings).
    listOf("Toolbar", "ActionBar", "NavigationBar", "TabBar").any(className::contains) ->
      StructuralRole.Toolbar
    // Progress indicators: Android ProgressBar, iOS UIProgressView/UIActivityIndicatorView.
    listOf(
        "ProgressBar",
        "UIProgressView",
        "UIActivityIndicatorView",
        "XCUIElementTypeActivityIndicator",
      )
      .any(className::contains) -> StructuralRole.Progress
    // Scroll containers: Android ScrollView/NestedScrollView, iOS UIScrollView, XCUITest
    // ScrollView.
    listOf("ScrollView", "XCUIElementTypeScrollView").any(className::contains) ->
      StructuralRole.ScrollView
    // Web content: Android WebView, iOS WKWebView / XCUIElementTypeWebView.
    listOf("WebView", "XCUIElementTypeWebView").any(className::contains) -> StructuralRole.WebView
    // Generic containers: Android layouts/view groups/Compose host; iOS structural wrappers. The
    // runner emits XCUIApplication + UIWindow for the mandatory root and window and UIView for any
    // non-semantic wrapper, so these must land in the same role as Android's FrameLayout/ViewGroup
    // or the two roots would never pair. The XCUIElementType* names are the XCUITest-native forms.
    //
    // The bare `android.view.View` (and its short `View` form) is folded in here too: both Android
    // extraction paths wrap the capture in a class-less synthetic root, and `HierarchyParser`
    // defaults a class-less node to `android.view.View` — so that is the class the live Android
    // compare root actually carries. Without this it would map to Other while the iOS root maps to
    // Container, and since every descendant key includes the root segment the two live trees would
    // stay wholly disjoint (issue #4872 review). A plain `View` is a generic wrapper regardless, so
    // this also mirrors iOS's `UIView -> Container` for non-root spacers.
    isStructuralContainer(className) -> StructuralRole.Container
    else -> StructuralRole.Other
  }
}

private fun isStructuralContainer(className: String): Boolean {
  val plainOrSyntheticView =
    className in setOf("android.view.View", "View", MULTI_WINDOW_ROOT_CLASS_NAME)
  val frameworkContainer =
    listOf(
        "Layout",
        "ViewGroup",
        "ComposeView",
        "XCUIApplication",
        "UIWindow",
        "UIView",
        "XCUIElementTypeApplication",
        "XCUIElementTypeWindow",
        "XCUIElementTypeGroup",
        "XCUIElementTypeOther",
      )
      .any(className::contains)
  return plainOrSyntheticView || frameworkContainer || className.endsWith("View")
}

private fun structuralListRole(className: String): StructuralRole? =
  when {
    className.contains("Cell") -> StructuralRole.ListItem
    listOf(
        "RecyclerView",
        "ListView",
        "GridView",
        "TableView",
        "CollectionView",
        "XCUIElementTypeTable",
      )
      .any(className::contains) -> StructuralRole.List
    else -> null
  }
