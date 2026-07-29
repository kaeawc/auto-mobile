import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]?
    )
        -> Bool
    {
        window = UIWindow(frame: UIScreen.main.bounds)
        if ProcessInfo.processInfo.environment["CTRL_PROXY_SNAPSHOT_GAP_TEST_MODE"] == "1" {
            window?.rootViewController = SnapshotGapViewController()
        } else {
            window?.rootViewController = UIViewController()
        }
        window?.rootViewController?.view.backgroundColor = .systemBackground
        window?.makeKeyAndVisible()
        return true
    }
}

private final class SnapshotGapViewController: UIViewController {
    private let composerGroup = UIView()
    private let messageTextView = UITextView()
    private let standardTextField = UITextField()
    private let secureTextField = UITextField()

    override func viewDidLoad() {
        super.viewDidLoad()

        composerGroup.accessibilityContainerType = .semanticGroup
        composerGroup.accessibilityLabel = "Composer"
        composerGroup.translatesAutoresizingMaskIntoConstraints = false

        messageTextView.isAccessibilityElement = true
        messageTextView.accessibilityLabel = "Message #sample"
        messageTextView.font = .preferredFont(forTextStyle: .body)
        messageTextView.backgroundColor = .secondarySystemBackground
        messageTextView.layer.cornerRadius = 8
        messageTextView.translatesAutoresizingMaskIntoConstraints = false

        standardTextField.isAccessibilityElement = true
        standardTextField.accessibilityLabel = "Standard field"
        standardTextField.accessibilityIdentifier = "standard-field"
        standardTextField.placeholder = "Standard field"
        standardTextField.borderStyle = .roundedRect
        standardTextField.translatesAutoresizingMaskIntoConstraints = false

        secureTextField.isAccessibilityElement = true
        secureTextField.accessibilityLabel = "Password"
        secureTextField.accessibilityIdentifier = "secure-field"
        secureTextField.placeholder = "Password"
        secureTextField.isSecureTextEntry = true
        secureTextField.borderStyle = .roundedRect
        secureTextField.translatesAutoresizingMaskIntoConstraints = false

        composerGroup.addSubview(messageTextView)
        view.addSubview(composerGroup)
        view.addSubview(standardTextField)
        view.addSubview(secureTextField)

        NSLayoutConstraint.activate([
            composerGroup.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            composerGroup.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            composerGroup.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 40),

            messageTextView.leadingAnchor.constraint(equalTo: composerGroup.leadingAnchor),
            messageTextView.trailingAnchor.constraint(equalTo: composerGroup.trailingAnchor),
            messageTextView.topAnchor.constraint(equalTo: composerGroup.topAnchor),
            messageTextView.heightAnchor.constraint(equalToConstant: 88),
            messageTextView.bottomAnchor.constraint(equalTo: composerGroup.bottomAnchor),

            standardTextField.leadingAnchor.constraint(equalTo: composerGroup.leadingAnchor),
            standardTextField.trailingAnchor.constraint(equalTo: composerGroup.trailingAnchor),
            standardTextField.topAnchor.constraint(equalTo: composerGroup.bottomAnchor, constant: 24),
            standardTextField.heightAnchor.constraint(equalToConstant: 44),

            secureTextField.leadingAnchor.constraint(equalTo: composerGroup.leadingAnchor),
            secureTextField.trailingAnchor.constraint(equalTo: composerGroup.trailingAnchor),
            secureTextField.topAnchor.constraint(equalTo: standardTextField.bottomAnchor, constant: 16),
            secureTextField.heightAnchor.constraint(equalToConstant: 44),
        ])
    }
}
