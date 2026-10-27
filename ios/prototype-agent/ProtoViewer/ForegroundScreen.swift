import UIKit

/// The screen the app is currently on, for MCP results. The iPhone Duo moves the app between its cover and
/// inner panels, so the host cannot know which one a save or open landed on without asking the app.
@MainActor
enum ForegroundScreen {
    /// Native pixels "WxH", from the active window scene's screen (not `UIScreen.main`, which names one
    /// fixed screen). Nil when no scene is connected yet.
    static func pixels() -> String? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
        else { return nil }
        let bounds = scene.screen.nativeBounds
        return PrototypeMcpScreen.format(widthPx: bounds.width, heightPx: bounds.height)
    }
}
