import SwiftUI

// A constant, well-formed literal.
// swiftlint:disable:next force_unwrapping
let protoViewerSecurityPolicyURL = URL(string: "https://github.com/kaeawc/auto-mobile/blob/main/SECURITY.md")!

@MainActor
struct LibrarySettingsView: View {
    let networkSwitch: PrototypeLibraryNetworkSwitch
    @Environment(\.dismiss) private var dismiss
    @State private var confirmsNetwork = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Allow network for imported prototypes", isOn: Binding(
                        get: { networkSwitch.enabled },
                        set: { enabled in
                            if enabled { confirmsNetwork = true }
                            else { networkSwitch.enabled = false }
                        }
                    ))
                    if networkSwitch.localNetworkDenied {
                        Text(
                            "Local network access was not granted, so network is off. Allow ProtoViewer under Settings > Privacy & Security > Local Network, then turn this on again."
                        )
                    }
                } footer: {
                    Text(
                        "Off by default. When enabled, private LAN addresses are allowed. Loopback, link-local addresses, and AutoMobile daemon ports on LAN addresses are blocked."
                    )
                }
                Section {
                    NavigationLink("Open-source licenses") { LicensesView() }
                        .accessibilityIdentifier("open-licenses")
                    Link("Security policy", destination: protoViewerSecurityPolicyURL)
                        .accessibilityIdentifier("open-security-policy")
                }
            }
            .readableContentWidth()
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog(
                "Allow network for imported prototypes?", isPresented: $confirmsNetwork, titleVisibility: .visible
            ) {
                Button("Allow network") { networkSwitch.enabled = true }
                Button("Cancel", role: .cancel) { confirmsNetwork = false }
            } message: {
                Text("Imported prototypes will be able to send requests to the internet and devices on your LAN.")
            }
        }
    }
}
