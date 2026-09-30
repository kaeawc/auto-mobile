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
            let arguments = ProcessInfo.processInfo.arguments
            let allowStorageMutations = arguments.contains("--allow-storage-mutations")
            if allowStorageMutations,
               let flagIndex = arguments.lastIndex(of: "--automobile-mutation-token"),
               arguments.indices.contains(flagIndex + 1)
            {
                DatabaseInspector.shared.authorizeMutationToken(arguments[flagIndex + 1])
            }
            do {
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
