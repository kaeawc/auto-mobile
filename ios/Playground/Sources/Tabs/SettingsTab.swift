import AutoMobileSDK
import SwiftUI

struct SettingsTab: View {
    @AppStorage("userName") private var userName = ""
    @AppStorage("notificationsEnabled") private var notificationsEnabled = true
    @AppStorage("darkModeEnabled") private var darkModeEnabled = false
    @AppStorage("analyticsEnabled") private var analyticsEnabled = true
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        NavigationStack {
            Form {
                Section(
                    header: Text("Account").font(theme.typography.labelLarge)
                        .foregroundStyle(theme.textSecondary)
                ) {
                    HStack {
                        Image(systemName: "person.circle.fill")
                            .font(theme.typography.displayMedium)
                            .foregroundStyle(theme.primary)

                        VStack(alignment: .leading) {
                            Text(userName.isEmpty ? "Guest User" : userName)
                                .font(theme.typography.titleMedium)
                                .foregroundStyle(theme.textPrimary)
                            Text("Tap to edit profile")
                                .font(theme.typography.labelMedium)
                                .foregroundStyle(theme.textSecondary)
                        }
                    }
                    .padding(.vertical, 8)

                    TextField("Display Name", text: $userName)
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                }
                .listRowBackground(theme.surface)

                Section(
                    header: Text("Preferences").font(theme.typography.labelLarge)
                        .foregroundStyle(theme.textSecondary)
                ) {
                    Toggle("Enable Notifications", isOn: $notificationsEnabled)
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                        .tint(theme.primary)

                    Toggle("Dark Mode", isOn: $darkModeEnabled)
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                        .tint(theme.primary)

                    Toggle("Analytics", isOn: $analyticsEnabled)
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                        .tint(theme.primary)
                }
                .listRowBackground(theme.surface)

                Section(
                    header: Text("Storage").font(theme.typography.labelLarge)
                        .foregroundStyle(theme.textSecondary)
                ) {
                    NavigationLink {
                        StorageSettingsView()
                    } label: {
                        Label("Manage Storage", systemImage: "internaldrive.fill")
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textPrimary)
                    }

                    NavigationLink {
                        CacheSettingsView()
                    } label: {
                        Label("Clear Cache", systemImage: "trash.fill")
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textPrimary)
                    }
                }
                .listRowBackground(theme.surface)

                Section(header: Text("About").font(theme.typography.labelLarge).foregroundStyle(theme.textSecondary)) {
                    HStack {
                        Text("Version")
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textPrimary)
                        Spacer()
                        Text("1.0.0")
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textSecondary)
                    }

                    HStack {
                        Text("Build")
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textPrimary)
                        Spacer()
                        Text("1")
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textSecondary)
                    }

                    Link(destination: URL(string: "https://github.com") ?? URL(fileURLWithPath: "/")) {
                        HStack {
                            Text("View Source Code")
                                .font(theme.typography.bodyLarge)
                                .foregroundStyle(theme.textPrimary)
                            Spacer()
                            Image(systemName: "arrow.up.right.square")
                                .foregroundStyle(theme.textSecondary)
                        }
                    }
                    .font(theme.typography.labelLarge)
                    .foregroundStyle(theme.primary)
                }
                .listRowBackground(theme.surface)

                Section {
                    Button("Sign Out", role: .destructive) {
                        userName = ""
                    }
                    .font(theme.typography.labelLarge)
                    .tint(theme.primary)
                    .foregroundStyle(theme.primary)
                }
                .listRowBackground(theme.surface)
            }
            .scrollContentBackground(.hidden)
            .background(theme.background)
            .navigationTitle("Settings")
        }
        .trackNavigation(destination: "SettingsTab")
        .onChange(of: analyticsEnabled) { _, newValue in
            AutoMobileSDK.shared.setEnabled(newValue)
            AutoMobileLog.shared.i("SettingsTab", "analytics_toggled enabled=\(newValue)")
        }
    }
}

struct StorageSettingsView: View {
    @State private var documents = 125.5
    @State private var cache = 45.2
    @State private var other = 12.8
    @Environment(\.autoMobileTheme) private var theme

    var total: Double {
        documents + cache + other
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 16) {
                    Text(String(format: "%.1f MB", total))
                        .font(theme.typography.displayMedium)
                        .foregroundStyle(theme.textPrimary)

                    Text("Total Storage Used")
                        .font(theme.typography.titleSmall)
                        .foregroundStyle(theme.textSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            }
            .listRowBackground(theme.surface)

            Section(header: Text("Breakdown").font(theme.typography.labelLarge).foregroundStyle(theme.textSecondary)) {
                StorageRow(title: "Documents", size: documents, color: .autoMobileLalala)
                StorageRow(title: "Cache", size: cache, color: theme.primary)
                StorageRow(title: "Other", size: other, color: .autoMobileDarkGrey)
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Storage")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct StorageRow: View {
    let title: String
    let size: Double
    let color: Color
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        HStack {
            Circle()
                .fill(color)
                .frame(width: 12, height: 12)

            Text(title)
                .font(theme.typography.bodyLarge)
                .foregroundStyle(theme.textPrimary)

            Spacer()

            Text(String(format: "%.1f MB", size))
                .font(theme.typography.bodyLarge)
                .foregroundStyle(theme.textSecondary)
        }
    }
}

struct CacheSettingsView: View {
    @State private var showingClearAlert = false
    @State private var isClearing = false
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        List {
            Section {
                VStack(spacing: 12) {
                    Image(systemName: "trash.circle.fill")
                        .font(theme.typography.displayLarge)
                        .foregroundStyle(theme.primary)

                    Text("45.2 MB")
                        .font(theme.typography.headlineLarge)
                        .fontWeight(.bold)
                        .foregroundStyle(theme.textPrimary)

                    Text("Cached data can be safely cleared")
                        .font(theme.typography.titleSmall)
                        .foregroundStyle(theme.textSecondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            }
            .listRowBackground(theme.surface)

            Section {
                Button {
                    showingClearAlert = true
                } label: {
                    HStack {
                        Spacer()
                        if isClearing {
                            ProgressView()
                        } else {
                            Text("Clear Cache")
                                .font(theme.typography.labelLarge)
                                .foregroundStyle(theme.primary)
                        }
                        Spacer()
                    }
                }
                .foregroundStyle(theme.primary)
                .disabled(isClearing)
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Clear Cache")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Clear Cache?", isPresented: $showingClearAlert) {
            Button("Cancel", role: .cancel) {}
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
            Button("Clear", role: .destructive) {
                clearCache()
            }
            .font(theme.typography.labelLarge)
            .foregroundStyle(theme.primary)
            .tint(theme.primary)
        } message: {
            Text("This will remove all cached data. Downloads and saved content will not be affected.")
                .font(theme.typography.bodyLarge)
                .foregroundStyle(theme.textPrimary)
        }
    }

    private func clearCache() {
        isClearing = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            isClearing = false
        }
    }
}

#Preview {
    SettingsTab()
        .autoMobileTheme()
}
