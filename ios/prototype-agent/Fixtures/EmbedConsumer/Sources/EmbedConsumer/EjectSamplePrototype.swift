// Generated once by automobile:prototype/eject?id=ejectSample&platform=ios.
// This file is yours: edit it freely. It is never regenerated or synced back to the spec.
// 7 TODO(eject) item(s) remain; search for TODO(eject).
import SwiftUI
import UIKit

struct EjectSamplePrototype: View {
    @StateObject private var ui = EjectSamplePrototypeState()

    var body: some View {
        Group {
            Group {
                switch ui.top("main") {
                case "home":
                    MainHomeScreen(ui: ui)
                case "detail":
                    MainDetailScreen(ui: ui)
                case "settings":
                    MainSettingsScreen(ui: ui)
                default:
                    EmptyView()
                }
            }
        }
        .tint(EjectSamplePrototypeTheme.primary)
    }
}

private struct MainHomeScreen: View {
    @ObservedObject var ui: EjectSamplePrototypeState

    var body: some View {
        Group {
            VStack(alignment: .leading) {
                Text(verbatim: "Ejected \"sample\" costs $5")
                .accessibilityIdentifier("title")
                Text(verbatim: "Spans joined")
                .onTapGesture { ui.push("main", "settings") }
                HStack {
                    Button {
                        ui.push("main", "detail")
                        /* TODO(eject): emit action */
                    } label: {
                        Text(verbatim: "Filled")
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("filled")
                    Button {
                    } label: {
                        Text(verbatim: "Tonal")
                    }
                    .buttonStyle(.bordered)
                    Button {
                    } label: {
                        Text(verbatim: "Elevated")
                    }
                    .buttonStyle(.bordered)
                    Button {
                    } label: {
                        Text(verbatim: "Outlined")
                    }
                    .buttonStyle(.bordered)
                    Button {
                        ui.replace("main", "detail")
                    } label: {
                        Text(verbatim: "Text")
                    }
                    .buttonStyle(.borderless)
                    Spacer()
                    .frame(width: 8, height: 8)
                    .accessibilityIdentifier("gap")
                    Divider()
                }
                .accessibilityIdentifier("buttons")
                ZStack {
                    VStack(alignment: .leading) {
                        TextField(text: ui.text("email"), prompt: Text(verbatim: "you@example.test")) { Text(verbatim: "Email") }
                        .textFieldStyle(.roundedBorder)
                        Text(verbatim: "Work address")
                            .font(.caption)
                    }
                    .accessibilityIdentifier("email")
                    TextField(text: ui.text("notes"), axis: .vertical) { Text(verbatim: "Notes") }
                    .textFieldStyle(.roundedBorder)
                    SecureField(text: ui.text("pin"), prompt: Text(verbatim: "PIN")) { Text(verbatim: "PIN") }
                    .textFieldStyle(.roundedBorder)
                }
                .accessibilityIdentifier("fields")
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading) {
                        Text(verbatim: "Header")
                        ForEach(0..<3, id: \.self) { index in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(verbatim: "{item.name}")
                                    Text(verbatim: "Row " + String(index))
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .contentShape(Rectangle())
                            .accessibilityIdentifier("row_" + String(index))
                            .onTapGesture { ui.push("main", "detail") }
                        }
                        Text(verbatim: "Footer")
                    }
                }
                .accessibilityIdentifier("feed")
                ScrollView(.horizontal) {
                    LazyHStack {
                        ForEach(0..<3, id: \.self) { index in
                            VStack(alignment: .leading) {
                                Text(verbatim: "{item.name}")
                            }
                            .padding()
                            .background(Color(UIColor.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityIdentifier("card_" + String(index))
                        }
                    }
                }
                Divider()
                // TODO(eject): searchBar at root.screens["home"].children[7] has no scaffold mapping; build it by hand.
                VStack(alignment: .leading) {
                    Text(verbatim: "TODO: searchBar")
                    Text(verbatim: "Suggestions")
                    .accessibilityIdentifier("suggestions")
                }
                .accessibilityIdentifier("search")
                // TODO(eject): adaptive at root.screens["home"].children[8] has no scaffold mapping; build it by hand.
                VStack(alignment: .leading) {
                    Text(verbatim: "TODO: adaptive")
                    Text(verbatim: "List pane")
                    .accessibilityIdentifier("listPane")
                    Text(verbatim: "Detail pane")
                    .accessibilityIdentifier("detailPane")
                }
                .accessibilityIdentifier("panes")
            }
            .accessibilityIdentifier("home")
        }
    }
}

private struct MainDetailScreen: View {
    @ObservedObject var ui: EjectSamplePrototypeState

    var body: some View {
        Group {
            ScrollView(.vertical) {
                VStack(alignment: .leading) {
                    Button {
                        ui.pop("main")
                    } label: {
                        Text(verbatim: "Back")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("back")
                    ScrollView(.horizontal) {
                        Text(verbatim: "Wide")
                    }
                }
            }
            .accessibilityIdentifier("detail")
        }
    }
}

private struct MainSettingsScreen: View {
    @ObservedObject var ui: EjectSamplePrototypeState

    var body: some View {
        Group {
            Group {
                switch ui.top("inner") {
                case "general":
                    InnerGeneralScreen(ui: ui)
                case "advanced":
                    InnerAdvancedScreen(ui: ui)
                default:
                    EmptyView()
                }
            }
        }
    }
}

private struct InnerGeneralScreen: View {
    @ObservedObject var ui: EjectSamplePrototypeState

    var body: some View {
        Group {
            VStack(alignment: .leading) {
                Button {
                    ui.push("inner", "advanced")
                } label: {
                    Text(verbatim: "Advanced")
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}

private struct InnerAdvancedScreen: View {
    @ObservedObject var ui: EjectSamplePrototypeState

    var body: some View {
        Group {
            VStack(alignment: .leading) {
                Button {
                    ui.popToRoot("main")
                } label: {
                    Text(verbatim: "Home")
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}

@MainActor
final class EjectSamplePrototypeState: ObservableObject {
    @Published private var stacks: [String: [String]] = [:]
    @Published private var texts: [String: String]
    private let starts: [String: String]

    init() {
        starts = Dictionary([("main", "home"), ("inner", "general")], uniquingKeysWith: { first, _ in first })
        texts = Dictionary([("email", "a@b.test"), ("notes", ""), ("pin", ""), ("query", "")], uniquingKeysWith: { first, _ in first })
    }

    func top(_ stack: String) -> String { path(stack).last ?? "" }
    func push(_ stack: String, _ screen: String) { stacks[stack] = path(stack) + [screen] }
    func pop(_ stack: String) { let p = path(stack); if p.count > 1 { stacks[stack] = Array(p.dropLast()) } }
    func popToRoot(_ stack: String) { stacks[stack] = [starts[stack] ?? ""] }
    func replace(_ stack: String, _ screen: String) { stacks[stack] = Array(path(stack).dropLast()) + [screen] }
    func text(_ key: String) -> Binding<String> {
        Binding(
            get: { MainActor.assumeIsolated { self.texts[key] ?? "" } },
            set: { value in MainActor.assumeIsolated { self.texts[key] = value } }
        )
    }

    private func path(_ stack: String) -> [String] { stacks[stack] ?? [starts[stack] ?? ""] }
}

enum EjectSamplePrototypeTheme {
    static let primary = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.816, green: 0.737, blue: 1.000, alpha: 0.502) : UIColor(red: 0.404, green: 0.314, blue: 0.643, alpha: 1.000) })
    static let surface = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.110, green: 0.106, blue: 0.122, alpha: 1.000) : UIColor(red: 1.000, green: 0.984, blue: 0.996, alpha: 1.000) })
}
