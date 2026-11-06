#if canImport(UIKit)
    import UIKit

    extension UIWindow: PrototypeEditingWindow {}

    @MainActor
    final class UIKitPrototypeIdleTimer: PrototypeApplicationIdleTimer {
        var isIdleTimerDisabled: Bool {
            get { UIApplication.shared.isIdleTimerDisabled }
            set { UIApplication.shared.isIdleTimerDisabled = newValue }
        }
    }

    @MainActor
    final class UIKitPrototypeScreen: PrototypeWindowScreen {
        private let screen: UIScreen
        init(screen: UIScreen) { self.screen = screen }
        var brightness: Double {
            get { Double(screen.brightness) }
            set { screen.brightness = CGFloat(newValue) }
        }
    }

    @MainActor
    final class UIKitSettingsURLOpener: PrototypeSettingsURLOpener {
        var appSettingsURL: URL? { URL(string: UIApplication.openSettingsURLString) }
        var notificationSettingsURL: URL? { URL(string: UIApplication.openNotificationSettingsURLString) }
        func open(_ url: URL) async -> Bool { await UIApplication.shared.open(url) }
    }

    /// The injected layers own their root policy. ProtoViewer's SwiftUI root uses the container
    /// below, so both runtimes use preferredStatusBarStyle without changing the host app's chrome.
    @MainActor
    class PrototypeWindowControlsViewController: UIViewController {
        var orientationMask: UIInterfaceOrientationMask?
        var statusStyle: PrototypeWindowStatusBar?

        override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
            orientationMask ?? super.supportedInterfaceOrientations
        }

        override var preferredStatusBarStyle: UIStatusBarStyle {
            switch statusStyle {
            case .light: .lightContent
            case .dark: .darkContent
            case .auto: traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
            case nil: super.preferredStatusBarStyle
            }
        }
    }

    /// Keeps the viewer's existing SwiftUI hierarchy as a child while it owns status-bar policy.
    /// An injected overlay already has its own root and never wraps the host app's root controller.
    @MainActor
    private final class PrototypeWindowControlsContainer: PrototypeWindowControlsViewController {
        let content: UIViewController

        init(content: UIViewController) {
            self.content = content
            super.init(nibName: nil, bundle: nil)
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) { fatalError("init(coder:) is not supported") }

        override func viewDidLoad() {
            super.viewDidLoad()
            addChild(content)
            content.view.frame = view.bounds
            content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(content.view)
            content.didMove(toParent: self)
        }

        override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
            orientationMask ?? content.supportedInterfaceOrientations
        }

        override var childForStatusBarStyle: UIViewController? { statusStyle == nil ? content : nil }
        override var childForStatusBarHidden: UIViewController? { content }
        override var preferredStatusBarStyle: UIStatusBarStyle {
            guard statusStyle == .auto else { return super.preferredStatusBarStyle }
            return content.traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
        }

        func detachContent() {
            content.willMove(toParent: nil)
            content.view.removeFromSuperview()
            content.removeFromParent()
        }
    }

    @MainActor
    final class UIKitPrototypeWindowChrome: PrototypeWindowChrome {
        private weak var window: UIWindow?
        private weak var controller: PrototypeWindowControlsViewController?
        private var previousOrientations: UIInterfaceOrientationMask?

        init(window: UIWindow) { self.window = window }

        private func controlsController() -> PrototypeWindowControlsViewController? {
            if let controller { return controller }
            guard let window, let root = window.rootViewController else { return nil }
            if let controller = root as? PrototypeWindowControlsViewController {
                self.controller = controller
                return controller
            }
            let container = PrototypeWindowControlsContainer(content: root)
            controller = container
            window.rootViewController = container
            return container
        }

        func requestOrientation(_ orientation: PrototypeWindowOrientation?) -> String {
            guard let window, let scene = window.windowScene else { return "unavailable: no window scene" }
            let controller: PrototypeWindowControlsViewController
            let mask: UIInterfaceOrientationMask
            if let orientation {
                guard let host = controlsController() else { return "unavailable: no root controller" }
                controller = host
                if previousOrientations == nil {
                    // The overlay is not key: restore the underlying app's orientation policy.
                    previousOrientations = scene.windows.first { $0.isKeyWindow && $0 !== window }?
                        .rootViewController?.supportedInterfaceOrientations ?? host.supportedInterfaceOrientations
                }
                switch orientation {
                case .portrait: mask = .portrait
                case .landscape: mask = .landscape
                case .unlocked: mask = .all
                }
                controller.orientationMask = mask
            } else {
                guard let host = self.controller, let previousOrientations else { return "unchanged" }
                controller = host
                mask = previousOrientations
                controller.orientationMask = nil
                self.previousOrientations = nil
            }
            controller.setNeedsUpdateOfSupportedInterfaceOrientations()
            // Geometry updates have an error callback, not a success callback. Do not claim rotation.
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
                NSLog("[AutoMobilePrototypeAgent] orientation request rejected: %@", error.localizedDescription)
            }
            return "requested: \(orientation?.rawValue ?? "host") (mask \(mask.rawValue))"
        }

        func setStatusBar(_ style: PrototypeWindowStatusBar?) {
            let host = style == nil ? controller : controlsController()
            host?.statusStyle = style
            host?.setNeedsStatusBarAppearanceUpdate()
        }

        func restore() {
            guard let controller else { return }
            // Do not replace a root the app installed while the prototype was shown.
            if let container = controller as? PrototypeWindowControlsContainer,
               window?.rootViewController === container
            {
                container.detachContent()
                window?.rootViewController = container.content
                container.content.setNeedsStatusBarAppearanceUpdate()
                container.content.setNeedsUpdateOfSupportedInterfaceOrientations()
            }
            self.controller = nil
        }
    }
#endif
