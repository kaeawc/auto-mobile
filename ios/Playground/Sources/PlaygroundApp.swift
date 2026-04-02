import AutoMobileSDK
import SwiftUI

@main
struct PlaygroundApp: App {
    init() {
        // Initialize AutoMobile SDK
        AutoMobileSDK.shared.initialize(bundleId: "dev.jasonpearson.automobile.Playground")

        // Enable storage inspection in debug builds
        #if DEBUG
        UserDefaultsInspector.shared.setEnabled(true)
        DatabaseInspector.shared.setEnabled(true)
        #endif

        AutoMobileLog.shared.i("PlaygroundApp", "app_launched")
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .autoMobileTheme()
        }
    }
}
