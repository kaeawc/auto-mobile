#if canImport(UIKit) && canImport(SwiftUI)
    import SwiftUI
    import Symbols

    /// Keep native symbol APIs here; the version/fallback decision lives in the pure core table.
    struct PrototypeIconEffectView<Content: View>: View {
        let activity: PrototypeIconMotionActivity
        let effect: IconEffect
        let value: JSONValue?
        let name: String
        let profile: PrototypeMotionProfile
        @ViewBuilder let content: () -> Content
        @State private var tick = 0
        @State private var scaleActive = false
        @State private var reportingLoop = false

        private var kind: PrototypeIconEffectKind? {
            PrototypeIconEffectKind(rawValue: effect.type)?.resolved(
                majorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion
            )
        }

        private var options: SymbolEffectOptions {
            guard let repeatSpec = effect.repeat else { return .nonRepeating }
            return repeatSpec.count.map { .repeat($0) } ?? .repeating
        }

        private var restingForCapture: Bool { effect.repeat != nil && activity.capturing }

        private var reportsLoop: Bool {
            profile == .full && !restingForCapture && effect.repeat != nil && kind != nil
        }

        private func reportLoop(_ active: Bool) {
            guard active != reportingLoop else { return }
            reportingLoop = active
            if active { activity.begin() } else { activity.end() }
        }

        var body: some View {
            rendered
                .transaction { if restingForCapture { $0.disablesAnimations = true } }
                .onChange(of: reportsLoop, initial: true) { _, active in reportLoop(active) }
                .onDisappear { reportLoop(false) }
                .onAppear { if effect.trigger == nil { tick += 1 } }
                .onChange(of: value) { _, _ in tick += 1 }
                .task(id: "\(tick):\(profile):\(effect.type):\(restingForCapture)") {
                    guard !restingForCapture else { scaleActive = false; return }
                    guard tick > 0, profile == .full, kind == .scale, effect.trigger == nil else { return }
                    var left = effect.repeat?.count ?? (effect.repeat == nil ? 1 : Int.max)
                    do {
                        while left > 0 {
                            left -= 1
                            scaleActive = true
                            try await Task.sleep(for: .milliseconds(300))
                            scaleActive = false
                            try await Task.sleep(for: .milliseconds(300))
                        }
                    } catch { scaleActive = false }
                }
        }

        @ViewBuilder private var rendered: some View {
            if profile == .off || restingForCapture { content() }
            else if profile == .reduced {
                if effect.type == "replace" {
                    content().id(name).transition(.opacity).animation(.easeInOut(duration: 0.25), value: name)
                } else { content() }
            } else if #available(iOS 17, *) {
                native
            } else { content() }
        }

        @available(iOS 17, *)
        @ViewBuilder private var native: some View {
            switch kind {
            case .bounce: content().symbolEffect(.bounce, options: options, value: tick)
            case .pulse: content().symbolEffect(.pulse, options: options, value: tick)
            case .scale: content().symbolEffect(
                    .scale.up,
                    options: options,
                    isActive: effect.trigger == nil ? scaleActive : truthy
                )
            case .variableColor: content().symbolEffect(.variableColor, options: options, value: tick)
            case .replace:
                content().contentTransition(.symbolEffect(.replace)).animation(.easeInOut(duration: 0.6), value: name)
            case .wiggle:
                if #available(iOS 18, *) { content().symbolEffect(.wiggle, options: options, value: tick) }
                else { content() }
            case .rotate:
                if #available(iOS 18, *) { content().symbolEffect(.rotate, options: options, value: tick) }
                else { content() }
            case .breathe:
                if #available(iOS 18, *) { content().symbolEffect(.breathe, options: options, value: tick) }
                else { content() }
            case .drawOn:
                if #available(iOS 26, *) {
                    content().symbolEffect(.drawOn, options: options, isActive: tick > 0).id(tick)
                } else { content() }
            case nil: content()
            }
        }

        private var truthy: Bool {
            guard let value else { return effect.trigger == nil }
            return value != .bool(false) && value != .null && value != .number(0) && value != .string("")
        }
    }
#endif
