#if canImport(UIKit)
    import SwiftUI

    /// Only toggles use the look seam here; other controls can migrate independently.
    @MainActor
    struct PrototypeToggleView: View {
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.prototypePalette) private var palette
        @State private var motionOwner = UUID()
        let node: PrototypeNode
        let model: PrototypeModel

        private var isOn: Bool {
            _ = model.refusedChanges
            return model.state[node.stateKey ?? ""]?.boolValue ?? false
        }

        private var profile: PrototypeMotionProfile {
            PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).profile
        }

        private var native: Bool {
            PrototypeComponentLook.resolve(type: node.type, design: model.spec?.theme?.design) == .platform
        }

        var body: some View {
            Group {
                if native {
                    nativeToggle
                } else {
                    materialToggle
                }
            }
            .onChange(of: isOn) { _, _ in
                guard native else { return }
                PrototypeComponentLook.trackToggleMotion(
                    profile: profile, owner: motionOwner, activity: model.keyframeActivity
                )
            }
            .onChange(of: native) { _, _ in model.keyframeActivity.stop(owner: motionOwner) }
            .onChange(of: profile) { _, _ in model.keyframeActivity.stop(owner: motionOwner) }
            .onDisappear { model.keyframeActivity.stop(owner: motionOwner) }
        }

        private func setValue(_ value: Bool) {
            guard value != isOn, let key = node.stateKey else { return }
            model.toggle(key, then: node.onTap ?? [])
        }

        @ViewBuilder private var nativeToggle: some View {
            Toggle(isOn: Binding(get: { isOn }, set: { value in setValue(value) })) {
                if let label = node.label { Text(label) }
            }
            .tint(ComponentColors(palette: palette).primary)
            .frame(minHeight: 44)
            .transaction { transaction in
                let duration = PrototypeComponentLook.toggleDurationMs(profile: profile)
                transaction.animation = duration == 0 ? nil : .easeInOut(duration: Double(duration) / 1000)
                transaction.disablesAnimations = duration == 0
            }
            .toggleStyle(PrototypeRowToggleStyle(
                checkbox: node.type == "checkbox", label: node.label,
                identifier: PrototypeComponentLook.identifier(
                    type: node.type, design: model.spec?.theme?.design,
                    testTag: node.testTag, owner: .toggle
                )
            ))
        }

        /// The previous Material drawing, including its accessibility values and layout.
        private var materialToggle: some View {
            Button { setValue(!isOn) } label: {
                HStack(spacing: 8) {
                    if node.type == "checkbox" {
                        PrototypeGlyph(symbol: isOn ? "checkmark.square.fill" : "square")
                        if let label = node.label { Text(label) }
                    } else {
                        if let label = node.label {
                            Text(label).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        PrototypeSwitchTrack(isOn: isOn)
                    }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(node.type == "switch" ? (isOn ? "1" : "0") : (isOn ? "checked" : "unchecked"))
            .accessibilityAddTraits(node.type == "switch" ? .isToggle : (isOn ? .isSelected : []))
        }
    }

    /// The Button is the sole accessible hit target. Its native switch drawing is decorative;
    /// never wrap this Button in accessibilityElement(children: .ignore) (#10899).
    private struct PrototypeRowToggleStyle: ToggleStyle {
        let checkbox: Bool
        let label: String?
        let identifier: String?

        func makeBody(configuration: Configuration) -> some View {
            identified(labelled(
                Button { configuration.isOn.toggle() } label: {
                    HStack(spacing: 8) {
                        if checkbox {
                            PrototypeGlyph(symbol: configuration.isOn ? "checkmark.square.fill" : "square")
                                .accessibilityHidden(true)
                            configuration.label
                        } else {
                            configuration.label.frame(maxWidth: .infinity, alignment: .leading)
                            Toggle(isOn: configuration.$isOn) { EmptyView() }
                                .toggleStyle(.switch)
                                .labelsHidden()
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            ))
            .accessibilityValue(PrototypeComponentLook.toggleAccessibilityValue(
                type: checkbox ? "checkbox" : "switch", isOn: configuration.isOn
            ))
            .accessibilityAddTraits(checkbox ? (configuration.isOn ? .isSelected : []) : .isToggle)
        }

        @ViewBuilder
        private func labelled(_ content: some View) -> some View {
            if let label { content.accessibilityLabel(label) }
            else { content }
        }

        @ViewBuilder
        private func identified(_ content: some View) -> some View {
            if let identifier { content.accessibilityIdentifier(identifier) }
            else { content }
        }
    }
#endif
