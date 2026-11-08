import SwiftUI

// Minimal visionOS fixture for scripts/visionos/smoke-visionos-simulator.sh.
// Built with swiftc against the xrsimulator SDK (no Xcode project), so the
// smoke test needs only the Xcode command-line tools and the visionOS runtime.
@main
struct SmokeFixtureApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("AutoMobile visionOS smoke")
                    .font(.title)
                    .accessibilityIdentifier("smoke-title")
                Button("Tap me") {}
                    .accessibilityIdentifier("smoke-button")
            }
            .padding()
        }
    }
}
