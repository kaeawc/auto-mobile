import SwiftUI

@main
struct AutoMobileTVTestApp: App {
    @State private var lastSelection = "none"

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 30) {
                Text("last: \(lastSelection)")
                    .accessibilityIdentifier("last")
                ForEach(0 ..< 3) { row in
                    HStack(spacing: 30) {
                        ForEach(0 ..< 3) { column in
                            let name = "B\(row)\(column)"
                            Button(name) { lastSelection = name }
                                .accessibilityIdentifier(name)
                        }
                    }
                }
            }
        }
    }
}
