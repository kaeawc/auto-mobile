import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo _: UISceneSession,
        options _: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let window = UIWindow(windowScene: windowScene)
        if ProcessInfo.processInfo.environment["CTRL_PROXY_SNAPSHOT_GAP_TEST_MODE"] == "1" {
            window.rootViewController = SnapshotGapViewController()
        } else {
            window.rootViewController = UIViewController()
        }
        window.rootViewController?.view.backgroundColor = .systemBackground
        self.window = window
        window.makeKeyAndVisible()
    }
}
