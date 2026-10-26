import UIKit

// Managed provider app for putAppFile `user_files` on iOS Simulators. With file
// sharing and open-in-place enabled in Info.plist, iOS exposes this app's
// Documents directory in Files, and the daemon stages files below
// Documents/automobile/<namespace>. The app has no other behavior.
@main
final class FilesFixtureAppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil
    )
        -> Bool
    {
        if let documents = try? FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) {
            try? FileManager.default.createDirectory(
                at: documents.appendingPathComponent("automobile"),
                withIntermediateDirectories: true
            )
        }
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBackground
        let label = UILabel()
        label.text = "AutoMobile Files fixture"
        label.textColor = .secondaryLabel
        label.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
        ])
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
