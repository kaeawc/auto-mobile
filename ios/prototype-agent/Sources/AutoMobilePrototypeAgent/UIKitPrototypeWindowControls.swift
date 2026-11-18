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

    /// The registry owns coordinators, but never keeps scenes or their controllers alive.
    @MainActor
    private final class UIKitPrototypeOrientationDriver: PrototypeOrientationDriver {
        private final class ControllerReference {
            weak var controller: PrototypeWindowControlsViewController?
            init(_ controller: PrototypeWindowControlsViewController) { self.controller = controller }
        }

        weak var scene: UIWindowScene?
        private let hostMask: UIInterfaceOrientationMask
        private var controllers: [ObjectIdentifier: ControllerReference] = [:]
        private(set) var result = "unchanged"

        init(scene: UIWindowScene, hostMask: UIInterfaceOrientationMask) {
            self.scene = scene
            self.hostMask = hostMask
        }

        var baseline: PrototypeOrientationBaseline {
            switch scene?.interfaceOrientation {
            case .portrait: .portrait
            case .portraitUpsideDown: .portraitUpsideDown
            case .landscapeLeft: .landscapeLeft
            case .landscapeRight: .landscapeRight
            default: .unknown
            }
        }

        func register(owner: ObjectIdentifier, controller: PrototypeWindowControlsViewController) {
            controllers[owner] = ControllerReference(controller)
        }

        func unregister(owner: ObjectIdentifier) {
            if let controller = controllers.removeValue(forKey: owner)?.controller {
                controller.orientationMask = nil
                controller.setNeedsUpdateOfSupportedInterfaceOrientations()
            }
        }

        func contains(controller: PrototypeWindowControlsViewController) -> Bool {
            controllers.values.contains { $0.controller === controller }
        }

        func applyLock(_ orientation: PrototypeWindowOrientation) {
            let mask: UIInterfaceOrientationMask = switch orientation {
            case .portrait: .portrait
            case .landscape: .landscape
            case .unlocked: .all
            }
            for reference in controllers.values {
                reference.controller?.orientationMask = mask
                reference.controller?.setNeedsUpdateOfSupportedInterfaceOrientations()
            }
            request(mask: mask, description: orientation.rawValue)
        }

        func restoreBaseline(_ baseline: PrototypeOrientationBaseline) {
            let mask: UIInterfaceOrientationMask = switch baseline {
            case .portrait: .portrait
            case .portraitUpsideDown: .portraitUpsideDown
            case .landscapeLeft: .landscapeLeft
            case .landscapeRight: .landscapeRight
            case .unknown: hostMask
            }
            let description = baseline == .unknown
                ? "host" : "host (restore \(baseline.rawValue), mask \(mask.rawValue))"
            request(mask: mask, description: description, includesMask: baseline == .unknown)
        }

        private func request(mask: UIInterfaceOrientationMask, description: String, includesMask: Bool = true) {
            guard let scene else {
                result = "unavailable: no window scene"
                return
            }
            // Geometry updates have an error callback, not a success callback. Do not claim rotation.
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
                NSLog("[AutoMobilePrototypeAgent] orientation request rejected: %@", error.localizedDescription)
            }
            result = "requested: \(description)" + (includesMask ? " (mask \(mask.rawValue))" : "")
        }
    }

    @MainActor
    private final class UIKitPrototypeSceneOrientationLock {
        private static var scenes: [ObjectIdentifier: UIKitPrototypeSceneOrientationLock] = [:]
        let driver: UIKitPrototypeOrientationDriver
        let lock: PrototypeOrientationLock

        private init(scene: UIWindowScene, hostMask: UIInterfaceOrientationMask) {
            let driver = UIKitPrototypeOrientationDriver(scene: scene, hostMask: hostMask)
            self.driver = driver
            lock = PrototypeOrientationLock(driver: driver)
        }

        static func shared(scene: UIWindowScene, hostMask: UIInterfaceOrientationMask)
            -> UIKitPrototypeSceneOrientationLock
        {
            scenes = scenes.filter { $0.value.driver.scene != nil && !$0.value.lock.isEmpty }
            let key = ObjectIdentifier(scene)
            if let existing = scenes[key] { return existing }
            let entry = UIKitPrototypeSceneOrientationLock(scene: scene, hostMask: hostMask)
            scenes[key] = entry
            return entry
        }

        static func isControlling(_ controller: PrototypeWindowControlsViewController) -> Bool {
            scenes.values.contains { $0.driver.contains(controller: controller) }
        }

        func release(owner: ObjectIdentifier) {
            driver.unregister(owner: owner)
            lock.release(owner: owner)
            if lock.isEmpty, let scene = driver.scene {
                let key = ObjectIdentifier(scene)
                if Self.scenes[key] === self { Self.scenes.removeValue(forKey: key) }
            }
        }
    }

    @MainActor
    final class UIKitPrototypeWindowChrome: PrototypeWindowChrome {
        private weak var window: UIWindow?
        private weak var controller: PrototypeWindowControlsViewController?
        private var orientationLock: UIKitPrototypeSceneOrientationLock?

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
            let owner = ObjectIdentifier(self)
            guard let orientation else {
                guard let orientationLock else { return "unchanged" }
                orientationLock.release(owner: owner)
                self.orientationLock = nil
                return orientationLock.driver.result
            }
            guard let window, let scene = window.windowScene else { return "unavailable: no window scene" }
            guard let host = controlsController() else { return "unavailable: no root controller" }
            if let orientationLock, orientationLock.driver.scene !== scene {
                orientationLock.release(owner: owner)
                self.orientationLock = nil
            }
            // The overlay is not key: restore the underlying app's orientation policy.
            let hostMask = scene.windows.first { $0.isKeyWindow && $0 !== window }?
                .rootViewController?.supportedInterfaceOrientations ?? host.supportedInterfaceOrientations
            let entry = orientationLock ?? UIKitPrototypeSceneOrientationLock.shared(scene: scene, hostMask: hostMask)
            orientationLock = entry
            entry.driver.register(owner: owner, controller: host)
            entry.lock.acquire(owner: owner, orientation: orientation)
            return entry.driver.result
        }

        func setStatusBar(_ style: PrototypeWindowStatusBar?) {
            let host = style == nil ? controller : controlsController()
            host?.statusStyle = style
            host?.setNeedsStatusBarAppearanceUpdate()
        }

        func restore() {
            guard let controller else { return }
            // Another embedded view may still own this same container.
            guard !UIKitPrototypeSceneOrientationLock.isControlling(controller) else {
                self.controller = nil
                return
            }
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
