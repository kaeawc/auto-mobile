import SwiftUI

struct StatusSheetDemo: View {
    @Environment(\.dismiss) private var dismiss
    @State private var status = ""
    @State private var notes = ""
    @State private var secureValue = ""
    @State private var clearAfter = "Never"

    var body: some View {
        NavigationStack {
            Form {
                TextField("Status", text: $status, prompt: Text("What's your status?"))
                    .accessibilityIdentifier("status.textField")

                TextEditor(text: $notes)
                    .frame(height: 100)
                    .accessibilityIdentifier("status.textEditor")
                    .accessibilityLabel("Notes")

                SecureField("Secure field", text: $secureValue)
                    .accessibilityIdentifier("status.secureField")

                Picker("Clear after", selection: $clearAfter) {
                    Text("Never").tag("Never")
                    Text("30 minutes").tag("30 minutes")
                    Text("1 hour").tag("1 hour")
                    Text("Today").tag("Today")
                }

                Text(status.isEmpty ? "(empty)" : status)
                    .accessibilityIdentifier("status.echo")
            }
            .playgroundContent()
            .navigationTitle("Set Status")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}
