import SwiftUI

@main
struct AutoMobileVisionTestApp: App {
    @State private var lastSelection = "none"
    @State private var typedText = ""

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 24) {
                Text("last: \(lastSelection)")
                    .accessibilityIdentifier("last")
                TextField("Text", text: $typedText)
                    .accessibilityIdentifier("field")
                ForEach(0 ..< 3) { row in
                    HStack(spacing: 24) {
                        ForEach(0 ..< 3) { column in
                            let name = "B\(row)\(column)"
                            Button(name) { lastSelection = name }
                                .accessibilityIdentifier(name)
                        }
                    }
                }
            }
            .padding(40)
            .ornament(attachmentAnchor: .scene(.bottom)) {
                Button("Ornament") { lastSelection = "orn" }
                    .accessibilityIdentifier("orn")
            }
        }
        .windowStyle(.plain)
    }
}
