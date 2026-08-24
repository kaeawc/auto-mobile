import Foundation

/// Classifies `UIWindow` subclasses for the in-process hierarchy walk.
///
/// iOS keeps empty system overlay windows at a *higher* `windowLevel` than the
/// app's own content window once any text input appears on screen
/// (`UITextEffectsWindow` for text-effects, `UIRemoteKeyboardWindow` for the
/// keyboard). A walker that selects the window purely by highest level would then
/// snapshot that empty overlay and drop the entire app tree — which is why the
/// in-app SDK hierarchy (and, downstream, iOS semantic-link discovery) went blank
/// on any screen that had shown a text field (issue #5560).
///
/// Pure string classification (no UIKit) so it runs on the macOS `swift test`
/// destination; the UIKit walker feeds it `String(describing: type(of: window))`.
public enum WindowClassification {
    /// UIKit-internal overlay window classes that never carry app content and must
    /// not be chosen over the real content window.
    public static let nonContentWindowClassNames: Set<String> = [
        "UITextEffectsWindow",
        "UIRemoteKeyboardWindow",
    ]

    public static func isNonContentWindow(className: String) -> Bool {
        nonContentWindowClassNames.contains(className)
    }
}
