import SwiftUI

@main
struct CtrlProxyWatchApp: App {
    @State private var crown = 0.0
    private enum CrownFocus: Hashable {
        case fixture, list
    }

    @FocusState private var crownFocus: CrownFocus?

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                VStack {
                    crownFixture
                        .frame(height: 95)
                    List {
                        NavigationLink {
                            Text("Watch smoke next")
                                .accessibilityIdentifier("watch-smoke-next")
                        } label: {
                            Text("watch-smoke-row")
                        }
                        .accessibilityIdentifier("watch-smoke-row")
                        ForEach(1 ... 30, id: \.self) { row in
                            Text("Scroll row \(row)")
                                .accessibilityIdentifier("watch-scroll-row-\(row)")
                                .onTapGesture { crownFocus = .list }
                        }
                    }
                    // Native List crown scrolling is active when focus leaves the value fixture.
                    .focusable()
                    .focused($crownFocus, equals: .list)
                }
            }
        }
    }

    private var crownFixture: some View {
        ZStack {
            Text("CtrlProxy Watch")
                .accessibilityIdentifier("ctrlproxy-crown")
                .focusable()
                .focused($crownFocus, equals: .fixture)
                .digitalCrownRotation(
                    $crown, from: -1000, through: 1000, by: 0.1,
                    sensitivity: .high, isContinuous: true, isHapticFeedbackEnabled: false
                )
                .onAppear { crownFocus = .fixture }
                .onTapGesture { crownFocus = .fixture }
            Text("crown \(crown, format: .number.precision(.fractionLength(2)))")
                .accessibilityIdentifier("ctrlproxy-crown-value")
                .offset(y: 40)
            Color.clear
                .frame(width: 0, height: 0)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Non-hittable fixture")
                .accessibilityIdentifier("ctrlproxy-non-hittable")
        }
    }
}
