import AutoMobileSDK
import SwiftUI

// MARK: - Accessibility Rotor Demo

/// Exercises SwiftUI custom VoiceOver rotors (`accessibilityRotor`).
///
/// Two rotors are declared over the same list so a consumer can distinguish
/// them by name: "Flagged Items" selects a sparse subset, "Landmarks" selects
/// the section anchors. Deliberately distinctive names — this screen doubles as
/// the fixture for probing whether custom rotors bridge out of the Simulator
/// through the macOS accessibility API (`AXCustomRotors`), where the rotor name
/// is the only way to tell a populated rotor from an empty one.
///
/// The view is split into small sub-expressions on purpose: inlining the list
/// and both rotor modifiers into a single `body` exceeds the type checker's
/// budget and fails to compile.
struct AccessibilityRotorDemo: View {
    struct Item: Identifiable {
        let id: Int
        let title: String
        let isFlagged: Bool
        let isLandmark: Bool
    }

    private static let instructions =
        "Turn on VoiceOver and rotate two fingers to switch between the "
            + "\"Flagged Items\" and \"Landmarks\" rotors, then flick up or down "
            + "to move between entries."

    private let items: [Item]
    private let flagged: [Item]
    private let landmarks: [Item]

    @Namespace private var rotorNamespace
    @Environment(\.autoMobileTheme) private var theme

    init() {
        let items: [Item] = (1 ... 24).map { index in
            Item(
                id: index,
                title: "Row \(index)",
                isFlagged: index.isMultiple(of: 5),
                isLandmark: index % 8 == 1
            )
        }
        self.items = items
        flagged = items.filter(\.isFlagged)
        landmarks = items.filter(\.isLandmark)
    }

    var body: some View {
        list
            .accessibilityRotor("Flagged Items") { rotorEntries(for: flagged) }
            .accessibilityRotor("Landmarks") { rotorEntries(for: landmarks) }
            .navigationTitle("Custom Rotors")
            .navigationBarTitleDisplayMode(.inline)
            .trackNavigation(destination: "AccessibilityRotorDemo")
    }

    private var list: some View {
        List {
            Section {
                Text(Self.instructions)
                    .font(theme.typography.bodyMedium)
                    .foregroundStyle(theme.textSecondary)
            }

            Section("Entries") {
                ForEach(items) { item in
                    row(for: item)
                        .accessibilityRotorEntry(id: item.id, in: rotorNamespace)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
    }

    @AccessibilityRotorContentBuilder
    private func rotorEntries(for subset: [Item]) -> some AccessibilityRotorContent {
        // The String-label overload takes an UNLABELED id; only the Text and
        // LocalizedStringKey overloads spell it `id:`.
        ForEach(subset) { item in
            AccessibilityRotorEntry(item.title, item.id, in: rotorNamespace)
        }
    }

    private func row(for item: Item) -> some View {
        HStack(spacing: 12) {
            Image(systemName: item.isFlagged ? "flag.fill" : "circle")
                .foregroundStyle(item.isFlagged ? Color.autoMobileWarning : theme.textSecondary)
                .frame(width: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(theme.typography.titleMedium)
                    .foregroundStyle(theme.textPrimary)

                if item.isLandmark {
                    Text("Landmark")
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(theme.textSecondary)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label(for: item))
    }

    private func label(for item: Item) -> String {
        var parts = [item.title]
        if item.isFlagged {
            parts.append("Flagged")
        }
        if item.isLandmark {
            parts.append("Landmark")
        }
        return parts.joined(separator: ", ")
    }
}

#Preview {
    NavigationStack {
        AccessibilityRotorDemo()
    }
    .autoMobileTheme()
}
