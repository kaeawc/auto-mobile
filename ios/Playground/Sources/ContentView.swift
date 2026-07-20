import AutoMobileSDK
import SwiftUI

enum Tab: Hashable {
    case discover
    case demos
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

            SettingsTab()
                .tabItem {
                    Label("Settings", systemImage: "gearshape.fill")
                }
                .tag(Tab.settings)
        }
        .tint(.autoMobileRed)
        .onChange(of: selectedTab) { _, newTab in
            SwiftUINavigationAdapter.shared.trackNavigation(
                destination: "\(newTab)",
                metadata: ["type": "tab_switch"]
            )
        }
    }
}

#Preview {
    ContentView()
        .autoMobileTheme()
}
