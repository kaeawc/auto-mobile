import AutoMobileSDK
import SwiftUI

enum Tab: String, Hashable {
    case discover
    case demos
    case files
    case settings
}

struct ContentView: View {
    /// Lets automation launch straight into a tab, e.g.
    /// `SIMCTL_CHILD_PLAYGROUND_INITIAL_TAB=demos xcrun simctl launch …`.
    /// The tab bar is not reachable through the macOS accessibility bridge
    /// (`UITabBar` bridges as an opaque group with no pressable children), so
    /// without this a probe cannot get off the first tab.
    private static var initialTab: Tab {
        switch ProcessInfo.processInfo.environment["PLAYGROUND_INITIAL_TAB"] {
        case "demos": return .demos
        case "files": return .files
        case "settings": return .settings
        default: return .discover
        }
    }

    @State private var selectedTab: Tab = ContentView.initialTab
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        TabView(selection: $selectedTab) {
            DiscoverTab()
                .tabItem {
                    Label("Discover", systemImage: "magnifyingglass")
                }
                .tag(Tab.discover)

            DemosTab()
                .tabItem {
                    Label("Demos", systemImage: "play.fill")
                }
                .tag(Tab.demos)

            FilesPickerProbeView()
                .tabItem {
                    Label("Files", systemImage: "folder")
                }
                .tag(Tab.files)

            SettingsTab()
                .tabItem {
                    Label("Settings", systemImage: "gearshape.fill")
                }
                .tag(Tab.settings)
        }
        // Tab bar accent flows from the design-system theme (marker red) applied
        // by `.autoMobileTheme()` at the app root — no hard-coded override here.
        .onAppear {
            trackTab(selectedTab)
        }
        .onChange(of: selectedTab) { _, newTab in
            trackTab(newTab)
        }
    }

    private func trackTab(_ tab: Tab) {
        SwiftUINavigationAdapter.shared.trackNavigation(
            destination: tab.rawValue,
            metadata: ["type": "tab_switch"]
        )
    }
}

#Preview {
    ContentView()
        .autoMobileTheme()
}
