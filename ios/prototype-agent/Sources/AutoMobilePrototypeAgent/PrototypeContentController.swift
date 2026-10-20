#if canImport(UIKit)
    import UIKit

    /// A normal app content controller. Its opaque root receives touches outside authored hit rects;
    /// the shared child only routes touches between the renderer's page and modal layers.
    @MainActor
    class PrototypeContentController: UIViewController {
        enum Geometry {
            case content
            case window
        }

        let model: PrototypeModel
        private let geometry: Geometry
        private let accessibilityNotification: UIAccessibility.Notification
        // Invalid embedded specs show a diagnostic without installing or updating the renderer.
        private let contentEnabled: Bool
        private let layers: PrototypeLayersViewController
        private weak var observedScene: UIWindowScene?
        private var appearanceObservation: (any UITraitChangeRegistration)?
        private var appliedAccessibility: PrototypeHostAccessibility?

        init(
            model: PrototypeModel,
            geometry: Geometry = .content,
            accessibilityNotification: UIAccessibility.Notification = .layoutChanged,
            contentEnabled: Bool = true
        ) {
            self.model = model
            self.geometry = geometry
            self.accessibilityNotification = accessibilityNotification
            self.contentEnabled = contentEnabled
            layers = PrototypeLayersViewController(model: model)
            super.init(nibName: nil, bundle: nil)
        }

        func stopObserving() {
            unregisterAppearanceObservation()
            NotificationCenter.default.removeObserver(self)
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .systemBackground
            loadContent()
        }

        func loadContent() {
            guard contentEnabled else { return }
            addChild(layers)
            layers.view.frame = view.bounds
            layers.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(layers.view)
            layers.didMove(toParent: self)
            model.onEndEditing = { [weak self] in self?.view.endEditing(true) }
            model.onSessionChange = { [weak self] session in
                self?.apply(session)
            }
            let center = NotificationCenter.default
            center.addObserver(
                self,
                selector: #selector(keyboardChanged(_:)),
                name: UIResponder.keyboardWillChangeFrameNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(keyboardHidden(_:)),
                name: UIResponder.keyboardWillHideNotification,
                object: nil
            )
            for name in [
                UIAccessibility.voiceOverStatusDidChangeNotification,
                UIAccessibility.switchControlStatusDidChangeNotification,
            ] {
                center.addObserver(self, selector: #selector(assistiveEscapeChanged(_:)), name: name, object: nil)
            }
            syncAssistiveEscape()
            syncAppearance()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            syncAppearanceObservation()
            syncAppearance()
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            unregisterAppearanceObservation()
        }

        override func willMove(toParent parent: UIViewController?) {
            if parent == nil { unregisterAppearanceObservation() }
            super.willMove(toParent: parent)
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            syncAppearanceObservation()
            guard contentEnabled, let window = view.window else { return }
            // SwiftUI hit rects and anchors use window coordinates; keyboard overlap uses the
            // embedded content rectangle, which can end above the window bottom.
            let origin = window.convert(CGPoint.zero, to: window.screen.coordinateSpace)
            if model.windowOrigin != origin { model.windowOrigin = origin }
            if model.windowSize != window.bounds.size { model.windowSize = window.bounds.size }
            switch geometry {
            case .content:
                let containerFrame = view.convert(view.bounds, to: window.screen.coordinateSpace)
                if model.keyboardContainerFrame != containerFrame { model.keyboardContainerFrame = containerFrame }
                if model.safeInsets != view.safeAreaInsets { model.safeInsets = view.safeAreaInsets }
            case .window:
                if model.safeInsets != window.safeAreaInsets { model.safeInsets = window.safeAreaInsets }
            }
            syncAppearance()
        }

        private func syncAppearanceObservation() {
            guard let scene = view.window?.windowScene else {
                unregisterAppearanceObservation()
                return
            }
            guard observedScene !== scene else { return }
            unregisterAppearanceObservation()
            observedScene = scene
            appearanceObservation = scene.registerForTraitChanges(
                [UITraitUserInterfaceStyle.self]
            ) { [weak self] (_: UIWindowScene, _: UITraitCollection) in
                self?.syncAppearance()
            }
        }

        private func unregisterAppearanceObservation() {
            if let observedScene, let appearanceObservation {
                observedScene.unregisterForTraitChanges(appearanceObservation)
            }
            appearanceObservation = nil
            observedScene = nil
        }

        func syncAppearance() {
            guard contentEnabled else { return }
            // Read the scene, as PrototypeAgent.syncDeviceAppearance does: the content's override
            // carries the resolved prototype mode and cannot tell us the device's own setting.
            let traits = view.window?.windowScene?.traitCollection ?? UITraitCollection.current
            model.setDeviceDark(traits.userInterfaceStyle == .dark)
            apply(model.session)
        }

        private func apply(_ session: PrototypeSession) {
            if let appearance = session.appearance {
                let style: UIUserInterfaceStyle = appearance.dark ? .dark : .light
                if overrideUserInterfaceStyle != style { overrideUserInterfaceStyle = style }
            }
            let flags = PrototypeHostAccessibility(session: session, windowShown: true)
            guard flags != appliedAccessibility else { return }
            appliedAccessibility = flags
            layers.apply(flags)
            UIAccessibility.post(notification: accessibilityNotification, argument: nil)
        }

        @objc
        private func keyboardChanged(_ note: Notification) {
            let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
            let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue
            model.setKeyboard(frame: frame, duration: duration)
        }

        @objc
        private func keyboardHidden(_ note: Notification) {
            let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue
            model.setKeyboard(frame: nil, duration: duration)
        }

        @objc
        private func assistiveEscapeChanged(_: Notification) {
            syncAssistiveEscape()
        }

        private func syncAssistiveEscape() {
            model.assistiveEscapeVisible = UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning
        }
    }
#endif
