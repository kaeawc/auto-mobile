import SwiftUI

@main
struct AutoMobileTVTestApp: App {
    @State private var lastSelection = "none"
    @State private var typedText = ""
    @State private var labeledText = ""
    @State private var secureText = ""

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 30) {
                Text("last: \(lastSelection)")
                    .accessibilityIdentifier("last")
                TextField("Text", text: $typedText)
                    .accessibilityIdentifier("am-text-field")
                ForEach(0 ..< 3) { row in
                    HStack(spacing: 30) {
                        ForEach(0 ..< 3) { column in
                            let name = "B\(row)\(column)"
                            Button(name) { lastSelection = name }
                                .accessibilityIdentifier(name)
                        }
                    }
                }
                TextField("Placeholder", text: $labeledText)
                    .accessibilityLabel("Label")
                    .accessibilityIdentifier("am-labeled-field")
                SecureField("Secret", text: $secureText)
                    .accessibilityIdentifier("am-secure-field")
            }
        }
    }
}
