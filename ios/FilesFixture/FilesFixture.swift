import UIKit

// Managed Files fixture for AutoMobile putAppFile `user_files` on the iOS Simulator (#15404).
// It only exists to own a Documents container that the Files app can show: Info.plist sets
// UIFileSharingEnabled and LSSupportsOpeningDocumentsInPlace. It has no AutoMobile SDK dependency.
@main
final class FilesFixture: UIResponder, UIApplicationDelegate {
    func application(
        _: UIApplication,
        configurationForConnecting session: UISceneSession,
        options _: UIScene.ConnectionOptions
    )
        -> UISceneConfiguration
    {
        let configuration = UISceneConfiguration(name: "Default", sessionRole: session.role)
        configuration.delegateClass = FilesFixtureSceneDelegate.self
        return configuration
    }
}

@objc(FilesFixtureSceneDelegate)
final class FilesFixtureSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo _: UISceneSession,
        options _: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
