import SwiftUI

@main
struct CtrlProxyWatchApp: App {
    var body: some Scene {
        WindowGroup {
            ZStack {
                Text("CtrlProxy Watch")
                Color.clear
                    .frame(width: 0, height: 0)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Non-hittable fixture")
                    .accessibilityIdentifier("ctrlproxy-non-hittable")
            }
        }
    }
}
