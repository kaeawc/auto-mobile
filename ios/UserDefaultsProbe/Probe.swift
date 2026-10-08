import Foundation
import UIKit

// Deliberately has no AutoMobile SDK dependency. Only the app process reads
// UserDefaults, so the smoke test cannot mistake a plist read for app visibility.
@main
final class Probe: UIResponder, UIApplicationDelegate {
    func application(
        _: UIApplication,
        configurationForConnecting session: UISceneSession,
        options _: UIScene.ConnectionOptions
    )
        -> UISceneConfiguration
    {
        let configuration = UISceneConfiguration(name: "Default", sessionRole: session.role)
        configuration.delegateClass = ProbeSceneDelegate.self
        return configuration
    }
}

@objc(ProbeSceneDelegate)
final class ProbeSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo _: UISceneSession,
        options _: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        do {
            guard let custom = UserDefaults(suiteName: "automobile.probe.custom") else {
                throw CocoaError(.coderInvalidValue)
            }
            var snapshot: [String: Any] = [:]
            for (name, defaults) in [("standard", UserDefaults.standard), ("custom", custom)] {
                if defaults.object(forKey: "sentinel") == nil {
                    defaults.set("preserve this unrelated value", forKey: "sentinel")
                    // Persist only the initial fixture seed. Cold-launch reads
                    // must work without an explicit preferences synchronization.
                    defaults.synchronize()
                }
                snapshot[name] = ["host", "flag", "count", "ratio", "sentinel"]
                    .reduce(into: [String: Any]()) { values, key in
                        values[key] = defaults.object(forKey: key)
                    }
            }
            let documents = try FileManager.default.url(
                for: .documentDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
                .write(to: documents.appendingPathComponent("observed.json"), options: [.atomic])
        } catch {
            NSLog("UserDefaultsProbe could not write its snapshot: %@", String(describing: error))
        }
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = UIViewController()
        window?.rootViewController?.view.backgroundColor = .white
        window?.makeKeyAndVisible()
    }
}
