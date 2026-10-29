#if canImport(UIKit)
    import GameController
    import SwiftUI
    import UIKit

    /// Shared gate for the root view and controller; focused SwiftUI nodes can reach either chain.
    @MainActor
    private func performPrototypeAccessibilityEscape(_ model: PrototypeModel?) -> Bool {
        guard let model else { return false }
        if model.popTopmostStack() { return true }
        guard model.hasEscape else { return false }
        model.dismiss(reason: .user)
        return true
    }

    /// The prototype window's root: the page's hosting view with the top layer's above it (see
    /// `PrototypeHostLayer`). Each lays out the whole window the same way and draws only its own layer,
    /// so their `.global` frames, and the hit rects reported from them, are both window coordinates.
    @MainActor
    final class PrototypeLayersViewController: UIViewController, UIGestureRecognizerDelegate {
        private let model: PrototypeModel
        private let page: UIHostingController<PrototypeRootView>
        private let top: UIHostingController<PrototypeRootView>

        init(model: PrototypeModel) {
            self.model = model
            page = UIHostingController(rootView: PrototypeRootView(model: model, layer: .page))
            top = UIHostingController(rootView: PrototypeRootView(model: model, layer: .top))
            super.init(nibName: nil, bundle: nil)
            model.syncDeviceState = { [weak self] in self?.syncDeviceState() }
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func loadView() {
            view = PrototypeLayersView(model: model)
        }

        override func viewDidLoad() {
            super.viewDidLoad()
            let center = NotificationCenter.default
            for name in [Notification.Name.GCMouseDidConnect, Notification.Name.GCMouseDidDisconnect] {
                center.addObserver(self, selector: #selector(pointerChanged(_:)), name: name, object: nil)
            }
            registerForTraitChanges(
                [UITraitHorizontalSizeClass.self, UITraitUserInterfaceIdiom.self]
            ) { (controller: PrototypeLayersViewController, _: UITraitCollection) in
                controller.syncDeviceState()
            }
            view.backgroundColor = .clear
            for host in [page, top] {
                // Only `PrototypeKeyboardLift` moves anything for the keyboard (#11042), and the window's
                // insets reach the spec through the model, so neither host applies a safe area of its
                // own. This is UIKit's switch: with only the root's `ignoresSafeArea`, a 300 pt sheet
                // still moved 527 pt for a 334 pt lift on an iOS 26.5 simulator.
                host.safeAreaRegions = SafeAreaRegions(PrototypeKeyboardLift.hostSafeAreaRegions)
                addChild(host)
                host.view.backgroundColor = .clear
                host.view.frame = view.bounds
                host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                view.addSubview(host.view)
                host.didMove(toParent: self)
            }
            (view as? PrototypeLayersView)?.hosts = (page.view, top.view)
            // One recognizer on the shared ancestor sees touches before authored hosting views;
            // recognition cancels their touch stream. Single-touch gestures cannot recognize it.
            let escape = UILongPressGestureRecognizer(target: self, action: #selector(escapeHeld(_:)))
            escape.numberOfTouchesRequired = 2
            escape.minimumPressDuration = PrototypeEscapeReveal.holdSeconds
            escape.cancelsTouchesInView = true
            escape.delaysTouchesBegan = false
            escape.delaysTouchesEnded = false
            escape.delegate = self
            view.addGestureRecognizer(escape)
        }

        override func viewWillLayoutSubviews() {
            syncDeviceState()
            super.viewWillLayoutSubviews()
        }

        @objc
        private func pointerChanged(_: Notification) { syncDeviceState() }

        private func syncDeviceState() {
            loadViewIfNeeded()
            let idiom: PrototypeDeviceIdiom
            #if targetEnvironment(macCatalyst)
                idiom = .mac
            #else
                switch traitCollection.userInterfaceIdiom {
                case .pad: idiom = .pad
                case .mac: idiom = .mac
                case .vision: idiom = .vision
                default: idiom = .phone
                }
            #endif
            model.updateDeviceState(PrototypeDeviceState(
                idiom: idiom,
                horizontalSizeClass: traitCollection.horizontalSizeClass == .regular ? .regular : .compact,
                windowWidth: view.bounds.width, windowHeight: view.bounds.height,
                systemVersion: UIDevice.current.systemVersion, pointer: GCMouse.current != nil
            ))
        }

        func gestureRecognizerShouldBegin(_: UIGestureRecognizer) -> Bool {
            model.hasEscape
        }

        func gestureRecognizer(
            _: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith _: UIGestureRecognizer
        )
            -> Bool
        {
            true
        }

        @objc
        private func escapeHeld(_ gesture: UILongPressGestureRecognizer) {
            if gesture.state == .began { model.revealEscape() }
        }

        override func accessibilityPerformEscape() -> Bool {
            performPrototypeAccessibilityEscape(model) || super.accessibilityPerformEscape()
        }

        /// Sets the UIKit flags an open dialog needs: the page leaves the accessibility tree and the top
        /// layer is modal, so the XCUITest snapshot lists only the dialog and the host dismiss control.
        func apply(_ flags: PrototypeHostAccessibility) {
            loadViewIfNeeded()
            (view as? PrototypeLayersView)?.accessibilityIdentifier = flags.windowMarked
                ? PrototypeHostChrome.windowMarkerIdentifier : nil
            page.view.accessibilityElementsHidden = flags.pageElementsHidden
            top.view.accessibilityViewIsModal = flags.topIsModal
        }
    }

    /// Routes each touch to the hosting view that drew what is under it. Both views fill the window,
    /// so without this the top one would take every touch, including those meant for the page.
    @MainActor
    private final class PrototypeLayersView: UIView {
        weak var model: PrototypeModel?
        var hosts: (page: UIView, top: UIView)?

        init(model: PrototypeModel) {
            self.model = model
            super.init(frame: .zero)
            // Keep both hosts' children; apply(flags) marks only a chromeless fullscreen session.
            isAccessibilityElement = false
        }

        @available(*, unavailable)
        required init?(coder _: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func accessibilityPerformEscape() -> Bool {
            performPrototypeAccessibilityEscape(model) || super.accessibilityPerformEscape()
        }

        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
            guard let model, let hosts,
                  let owner = model.hitRects.layer(at: convert(point, to: nil))
            else { return nil }
            let target = owner == .top ? hosts.top : hosts.page
            // Opacity-zero authored content may decline the accepted touch. Keep the fullscreen
            // escape recognizer's ancestor in the touch chain; this path is not yet device-verified.
            return target.hitTest(convert(point, to: target), with: event) ?? (model.hasEscape ? self : nil)
        }
    }

    /// Lays out the shown spec by placement and records the touchable rects for the window. `layer`
    /// picks what this hosting view draws: the page (the spec's tree and anchor layer) or the top
    /// layer (open dialogs and snackbars and the host dismiss control).
    @MainActor
    struct PrototypeRootView: View {
        let model: PrototypeModel
        let layer: PrototypeHostLayer
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
        @Environment(\.layoutDirection) private var layoutDirection
        @Namespace private var sharedNamespace
        @State private var swipe = PrototypeStackSwipeState()
        @GestureState private var swipeActive = false

        var body: some View {
            // The model's one resolved mode, not this window's `colorScheme`: the window carries that
            // mode as its UIKit override, so its own scheme no longer says what the device is set to.
            let palette = PrototypePalette.make(theme: model.spec?.theme, dark: model.dark)
            let chip = PrototypeHostChrome.closeChipColors(palette: palette)
            // An open dialog makes the page behind it inert for accessibility, as it is for touches
            // (#10899). VoiceOver honours this collapse; the XCUITest snapshot needs the UIKit flags
            // `PrototypeLayersViewController.apply` sets on the page's hosting view.
            let pageAccessibility = model.spec?.root.layerAccessibility(
                state: model.state,
                pages: model.pages,
                stacks: model.stacks,
                data: model.spec?.data
            )
                ?? .container
            ZStack {
                if let spec = model.spec {
                    let chrome = PrototypeHostChrome(
                        placementType: spec.window.placement.type,
                        chrome: spec.window.chrome
                    )
                    let opacity = Double(spec.window.opacity ?? 100) / 100
                    if chrome.reservesDismissBar {
                        // Like Android's fullscreen window: the bar takes the top of the screen and the
                        // spec and its dialogs are laid out and clipped below it, so the control never
                        // covers authored content and a dialog scrim never covers the control. The page
                        // layer keeps the bar's space empty; the top layer draws the bar.
                        VStack(spacing: 0) {
                            if layer == .top {
                                dismissBar(chrome, palette: palette)
                            } else {
                                Color.clear.frame(height: chrome.dismissBarHeight(safeTop: model.safeInsets.top))
                            }
                            // The clear base fixes the content area to the space left under the bar;
                            // the spec and the modal layer are laid out in it separately, so a dialog
                            // taller than that area neither pushes the bar up nor moves the spec.
                            Color.clear
                                .overlay {
                                    if layer == .page {
                                        placed(spec, layer: pageAccessibility, palette: palette).opacity(opacity)
                                    }
                                }
                                .overlay {
                                    if layer == .page {
                                        anchorLayer(spec).opacity(opacity)
                                            .prototypeLayerAccessibility(pageAccessibility)
                                    }
                                }
                                .overlay {
                                    if layer == .top {
                                        PrototypeModalLayer(model: model).opacity(opacity)
                                    }
                                }
                                .clipped()
                        }
                    } else if layer == .page {
                        placed(spec, layer: pageAccessibility, palette: palette).opacity(opacity)
                        anchorLayer(spec).opacity(opacity).prototypeLayerAccessibility(pageAccessibility)
                    } else {
                        PrototypeModalLayer(model: model).opacity(opacity)
                        if chrome.escape {
                            if model.escapeRevealed || model.assistiveEscapeVisible {
                                dismissPill(glyph: Color(chip.glyph), fill: Color(chip.fill))
                                    .padding(.top, model.safeInsets.top + 8)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                            }
                        } else {
                            dismissControl(glyph: Color(chip.glyph), fill: Color(chip.fill))
                                .padding(.top, model.safeInsets.top)
                                .padding(.trailing, max(model.safeInsets.right, 8))
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                        }
                    }
                }
            }
            // Scheme-aware system controls (text fields, buttons) follow the theme's light or dark.
            .environment(\.colorScheme, palette.dark ? .dark : .light)
            .environment(\.prototypeSharedNamespace, sharedNamespace)
            .environment(\.prototypePalette, palette)
            .environment(\.prototypeTypography, PrototypeTypography(theme: model.spec?.theme?.typography))
            .environment(\.prototypeShapes, PrototypeShapes(theme: model.spec?.theme?.shapes))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Bars and cutouts are the spec's job (safeAreaPadding). A bottom sheet is raised by the
            // keyboard frame itself (`keyboardLift`) and nothing else moves for the keyboard, as on
            // Android: the hosts keep no safe area (`PrototypeKeyboardLift.hostSafeAreaRegions`), and
            // this ignores every region too, so no second lift can stack on the sheet's (#11042).
            .ignoresSafeArea()
            // Edge navigation observes authored scroll/pager gestures without reserving a touch strip.
            .simultaneousGesture(
                DragGesture(minimumDistance: 10, coordinateSpace: .global)
                    .updating($swipeActive) { _, active, _ in active = true }
                    .onChanged(edgeSwipeChanged)
                    .onEnded(edgeSwipeEnded)
            )
            .onChange(of: swipeActive) { _, active in
                if !active { cancelEdgeSwipe() }
            }
            .onDisappear { cancelEdgeSwipe() }
        }

        private var swipeRTL: Bool { layoutDirection == .rightToLeft }

        private func swipeAnimation(_ target: String) -> PrototypeStackAnimation {
            switch model.stackTransition(target) {
            case .sharedAxisX, .sharedAxisY, .fadeThrough: return .none
            default: break
            }
            return PrototypeStackNavigation.animation(
                declared: model.stackTransition(target), specMotion: model.spec?.motion,
                reduceMotion: reduceMotion, direction: .pop
            )
        }

        private func edgeSwipeChanged(_ value: DragGesture.Value) {
            guard model.stackDrag?.settling != true, let target = model.stackPopTarget,
                  !model.nativeZoomStacks.contains(target),
                  let revision = model.stackChanges[target]?.revision else { return }
            swipe.update(
                target: target, revision: revision, start: value.startLocation.x,
                translation: value.translation.width, vertical: value.translation.height,
                width: model.windowSize.width, rtl: swipeRTL
            )
            guard swipe.target == target, swipe.revision == revision else {
                cancelEdgeSwipe()
                return
            }
            guard swipeAnimation(target) == .slide else { return }
            model.stackDrag = PrototypeModel.StackDrag(
                target: target, revision: revision, progress: swipe.progress
            )
        }

        private func cancelEdgeSwipe() {
            swipe.cancel()
            guard model.stackDrag?.settling != true else { return }
            withAnimation(
                PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).spatial
                    ? .easeOut(duration: 0.2) : nil
            ) { model.stackDrag = nil }
        }

        private func edgeSwipeEnded(_ value: DragGesture.Value) {
            guard let ended = swipe.end(), !model.nativeZoomStacks.contains(ended.target) else { return }
            let (target, revision) = ended
            guard model.stackPopTarget == target, model.stackChanges[target]?.revision == revision else {
                cancelEdgeSwipe()
                return
            }
            guard swipeAnimation(target) == .slide, let drag = model.stackDrag else {
                model.stackDrag = nil
                if PrototypeStackSwipe.distance(translation: value.translation.width, rtl: swipeRTL) >= 60,
                   abs(value.translation.height) < abs(value.translation.width) { model.popTopmostStack() }
                return
            }
            let commit = PrototypeStackSwipe.commits(
                translation: value.translation.width, predicted: value.predictedEndTranslation.width,
                width: model.windowSize.width, rtl: swipeRTL
            )
            model.stackDrag?.settling = true
            withAnimation(
                .easeOut(duration: 0.35 * (commit ? 1 - drag.progress : drag.progress)), completionCriteria: .removed
            ) {
                model.stackDrag?.progress = commit ? 1 : 0
            } completion: {
                guard model.stackChanges[target]?.revision == revision else { return }
                if commit, model.stackPopTarget == target {
                    model.completedStackSwipe = target
                    model.popTopmostStack()
                } else {
                    model.stackDrag = nil
                }
            }
        }

        /// The spec's anchored nodes, above its tree and below its modals, as Android's anchor layer.
        private func anchorLayer(_ spec: PrototypeSpec) -> some View {
            let placement = spec.window.placement
            let motion = PrototypeMotion(specMotion: spec.motion, reduceMotion: reduceMotion)
            return PrototypeAnchorLayer(
                entries: spec.root.windowAnchorLayer(
                    state: model.state, pages: model.pages, stacks: model.stacks, retainExiting: motion.enabled
                ),
                model: model,
                sheet: placement.type == "sheet"
                    ? PrototypeAnchorLayer.Sheet(edge: placement.edge, height: placement.height, lift: keyboardLift)
                    : nil
            )
            .animation(keyboardLiftDuration.map { .easeInOut(duration: $0) }, value: keyboardLift)
        }

        /// How far the bottom sheet is raised and how long the move takes: the keyboard's own duration,
        /// or instant under spec `motion: "none"` or Reduce Motion.
        private var keyboardLift: Double {
            model.keyboardLift
        }

        private var keyboardLiftDuration: Double? {
            PrototypeKeyboardLift.animationDuration(
                keyboardDuration: model.keyboardDuration,
                motion: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
            )
        }

        @ViewBuilder
        private func placed(
            _ spec: PrototypeSpec,
            layer: PrototypeLayerAccessibility,
            palette: PrototypePalette
        )
            -> some View
        {
            let placement = spec.window.placement
            // The boundary sits on the root itself, inside the placement's fill frames, so a lone
            // node keeps its own accessibility frame (#10898).
            let root = NodeView(node: spec.root, model: model).prototypeLayerAccessibility(layer)
            // There is no window to move onto an anchored root: the anchor layer places it, and an
            // empty sheet or floating slot must not catch touches meant for the app.
            let rootAnchored = spec.root.anchor != nil
            switch placement.type {
            case "sheet" where rootAnchored, "floating" where rootAnchored:
                EmptyView()
            case "sheet":
                let edge: Alignment = placement.edge == "top" ? .top : .bottom
                root
                    .frame(maxWidth: .infinity)
                    .frame(height: placement.height ?? PrototypeSheetFrame.defaultHeight)
                    .background { backdrop(spec, palette: palette) }
                    .reportFrame(key: "content", model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: edge)
                    // The sheet's frame is reported from inside, so its touch rect follows the lift.
                    .padding(.bottom, keyboardLift)
                    .animation(keyboardLiftDuration.map { .easeInOut(duration: $0) }, value: keyboardLift)
            case "floating":
                root
                    .background { backdrop(spec, palette: palette) }
                    .offset(x: placement.offset?.x ?? 0, y: placement.offset?.y ?? 0)
                    .reportFrame(key: "content", model: model)
                    .padding(EdgeInsets(
                        top: model.safeInsets.top, leading: model.safeInsets.left,
                        bottom: model.safeInsets.bottom, trailing: model.safeInsets.right
                    ))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: swiftUIAlignment(placement.gravity))
            default:
                // Fullscreen blocks the app, like the Android full-screen window.
                ZStack(alignment: .topLeading) {
                    backdrop(spec, palette: palette)
                    palette.scrim(placement.scrim).map { Color($0) } ?? .clear
                    root
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .contentShape(Rectangle())
                .reportFrame(key: "content", model: model)
            }
        }

        /// `window.backdrop` (#15126): the Material, or the tonal fill where blur is unavailable.
        /// Nothing is drawn without one.
        @ViewBuilder
        private func backdrop(_ spec: PrototypeSpec, palette: PrototypePalette) -> some View {
            if let backdrop = spec.window.backdrop {
                PrototypeBackdropView(
                    plan: PrototypeBackdropPlan.resolve(
                        backdrop,
                        osMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
                        reduceTransparency: reduceTransparency
                    ),
                    palette: palette
                )
            }
        }

        /// Host-owned control the spec cannot remove (#9307).
        private func dismissControl(glyph: Color, fill: Color) -> some View {
            Button {
                model.dismiss(reason: .user)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(glyph)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(fill))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier("automobile-prototype-dismiss")
            .accessibilityLabel("Dismiss prototype")
            .reportFrame(key: "dismiss", model: model)
        }

        /// Drawn above the modal layer without authored opacity, including under assistive technology.
        private func dismissPill(glyph: Color, fill: Color) -> some View {
            Button {
                model.dismiss(reason: .user)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "xmark")
                    Text("Dismiss prototype")
                }
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(glyph)
                .padding(.horizontal, 16)
                .frame(minHeight: PrototypeHostChrome.controlSide)
                .background(Capsule().fill(fill))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("automobile-prototype-dismiss")
            .accessibilityLabel("Dismiss prototype")
            .reportFrame(key: "escape", model: model)
        }

        /// The fullscreen dismiss bar: it clears the status bar and cutout, holds only the control, and
        /// is translucent and themed like the spec (Android's `prototypeDismissColors`, #10522). Its rect
        /// is a hit rect, so a tap on the bar beside the control still never reaches the covered app.
        private func dismissBar(_ chrome: PrototypeHostChrome, palette: PrototypePalette) -> some View {
            let colors = PrototypeHostChrome.dismissBarColors(palette: palette)
            let content = Color(colors.content)
            return dismissControl(glyph: content, fill: content.opacity(0.12))
                .padding(.top, model.safeInsets.top)
                .padding(.leading, model.safeInsets.left)
                .padding(.trailing, max(model.safeInsets.right, 8))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .frame(height: chrome.dismissBarHeight(safeTop: model.safeInsets.top), alignment: .bottom)
                .background(Color(colors.background))
                .reportFrame(key: "dismissBar", model: model)
        }
    }

    extension View {
        /// Applies a layer's accessibility shape. The child behaviour is a value rather than a
        /// branch, so the layer keeps its view identity (and scroll positions) when a dialog opens.
        func prototypeLayerAccessibility(_ layer: PrototypeLayerAccessibility) -> some View {
            accessibilityElement(children: layer == .collapsed ? .ignore : .contain)
                .accessibilityHidden(layer == .collapsed)
        }

        /// Reports this view's window frame while it is on screen.
        /// With `clip`, only the part of the frame inside it takes touches; `enabled: false` withdraws
        /// the rect while the view stays on screen (an anchored node fading out with its ancestor).
        @MainActor
        func reportFrame(key: String, model: PrototypeModel, clip: CGRect? = nil, enabled: Bool = true) -> some View {
            modifier(PrototypeFrameReporter(key: key, model: model, clip: clip, enabled: enabled))
        }
    }

    @MainActor
    private struct PrototypeFrameReporter: ViewModifier {
        private struct Configuration: Equatable {
            let key: String
            let clip: CGRect?
            let enabled: Bool
        }

        let key: String
        let model: PrototypeModel
        let clip: CGRect?
        let enabled: Bool
        @Environment(\.prototypeStackActive) private var stackActive
        // Branches sharing a key still have distinct view lifetimes (#12207).
        @State private var owner = PrototypeHitRectOwner()
        @State private var frame: CGRect?

        private var configuration: Configuration { Configuration(key: key, clip: clip, enabled: enabled && stackActive)
        }

        func body(content: Content) -> some View {
            content
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                    self.frame = frame
                    report(frame, configuration: configuration)
                }
                .onChange(of: configuration) { old, now in
                    if old.key != now.key { model.hitRects.withdraw(key: old.key, owner: owner) }
                    // Use all new inputs, even when they change together without a geometry update.
                    if let frame { report(frame, configuration: now) }
                }
                .onDisappear { model.hitRects.withdraw(key: key, owner: owner) }
        }

        private func report(_ frame: CGRect, configuration: Configuration) {
            let touchable = configuration.clip.map { frame.intersection($0) } ?? frame
            model.hitRects.report(
                configuration.enabled && !touchable.isNull && !touchable.isEmpty ? touchable : nil,
                key: configuration.key, owner: owner
            )
        }
    }

    /// Calls back after the next display frame, so a visual change made just before is on screen.
    /// Falls back after 100 ms if no frame is delivered (backgrounded app, paused display link).
    @MainActor
    final class FrameWaiter: NSObject {
        private var link: CADisplayLink?
        private var completion: (() -> Void)?

        static func nextFrame(_ completion: @escaping () -> Void) {
            let waiter = FrameWaiter()
            waiter.completion = completion
            let link = CADisplayLink(target: waiter, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            waiter.link = link
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100)) { waiter.finish() }
        }

        @objc
        private func tick() {
            finish()
        }

        private func finish() {
            link?.invalidate()
            link = nil
            let done = completion
            completion = nil
            done?()
        }
    }

    extension SafeAreaRegions {
        /// The UIKit regions for the agent's device-free `PrototypeHostSafeAreaRegions`.
        init(_ regions: PrototypeHostSafeAreaRegions) {
            self = []
            if regions.contains(.container) { insert(.container) }
            if regions.contains(.keyboard) { insert(.keyboard) }
        }
    }

    /// The colour layers of a `window.backdrop`: Material (or Liquid Glass) plus a light tint, or the
    /// tonal fill (#15126).
    private struct PrototypeBackdropView: View {
        let plan: PrototypeBackdropPlan
        let palette: PrototypePalette

        var body: some View {
            ZStack {
                switch plan.mode {
                case .blur:
                    blurLayer
                    if let tint { tint.opacity(PrototypeBackdropPlan.blurTintAlpha) }
                case .fallback:
                    (tint ?? Self.color(palette, PrototypeBackdropPlan.defaultTonalRole))
                        .opacity(PrototypeBackdropPlan.tonalAlpha)
                }
            }
            .accessibilityHidden(true)
            .allowsHitTesting(false)
        }

        private var tint: Color? {
            plan.tint.map { Self.color(palette, $0) }
        }

        private static func color(_ palette: PrototypePalette, _ spec: String) -> Color {
            palette.resolve(spec).map { Color($0) } ?? .clear
        }

        @ViewBuilder private var blurLayer: some View {
            switch plan.material {
            case .ultraThin: Rectangle().fill(.ultraThinMaterial)
            case .thin: Rectangle().fill(.thinMaterial)
            case .regular: Rectangle().fill(.regularMaterial)
            case .thick: Rectangle().fill(.thickMaterial)
            case .glass:
                if #available(iOS 26, *) {
                    Rectangle().fill(.clear).glassEffect(.regular, in: Rectangle())
                } else {
                    Rectangle().fill(.regularMaterial)
                }
            }
        }
    }
#endif
