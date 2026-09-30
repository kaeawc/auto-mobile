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
            do {
                let allowStorageMutations = ProcessInfo.processInfo.arguments.contains(
                    "--allow-storage-mutations"
                )
                try PlaygroundDatabaseFixture().install(allowMutations: allowStorageMutations)
            } catch {
                AutoMobileLog.shared.e("PlaygroundApp", "database_fixture_failed error=\(error.localizedDescription)")
            }
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
