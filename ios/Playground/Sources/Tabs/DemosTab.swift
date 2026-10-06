import AutoMobileSDK
import SwiftUI

struct DemosTab: View {
    @Environment(\.autoMobileTheme) private var theme
    @State private var shouldOpenTapAtTargets = false
    @State private var didCheckDeepLink = false

    var body: some View {
        NavigationStack {
            List {
                Section(
                    header: Text("SDK Features").font(theme.typography.labelLarge)
                        .foregroundStyle(theme.textSecondary)
                ) {
                    NavigationLink {
                        SDKStatusDemo()
                    } label: {
                        DemoRow(
                            title: "SDK Status",
                            description: "AutoMobile SDK state and controls",
                            icon: "antenna.radiowaves.left.and.right"
                        )
                    }

                    NavigationLink {
                        ErrorTrackingDemo()
                    } label: {
                        DemoRow(
                            title: "Error Tracking",
                            description: "Test handled exception recording",
                            icon: "exclamationmark.octagon.fill"
                        )
                    }

                    NavigationLink {
                        BiometricsDemo()
                    } label: {
                        DemoRow(
                            title: "Biometrics",
                            description: "Test biometric override injection",
                            icon: "faceid"
                        )
                    }

                    NavigationLink {
                        NetworkTrackingDemo()
                    } label: {
                        DemoRow(
                            title: "Network Tracking",
                            description: "Test network request monitoring",
                            icon: "network"
                        )
                    }
                }
                .listRowBackground(theme.surface)

                Section(
                    header: Text("Performance").font(theme.typography.labelLarge)
                        .foregroundStyle(theme.textSecondary)
                ) {
                    NavigationLink {
                        ScrollPerformanceDemo()
                    } label: {
                        DemoRow(
                            title: "Scroll Performance",
                            description: "Test scrolling with many items",
                            icon: "scroll.fill"
                        )
                    }

                    NavigationLink {
                        AnimationDemo()
                    } label: {
                        DemoRow(
                            title: "Animations",
                            description: "Various animation types and timings",
                            icon: "wand.and.stars"
                        )
                    }

                    NavigationLink {
                        HeavyComputationDemo()
                    } label: {
                        DemoRow(
                            title: "Heavy Computation",
                            description: "Stress test with intensive calculations",
                            icon: "cpu.fill"
                        )
                    }
                }
                .listRowBackground(theme.surface)

                Section(
                    header: Text("UI Components").font(theme.typography.labelLarge)
                        .foregroundStyle(theme.textSecondary)
                ) {
                    NavigationLink {
                        FormDemo()
                    } label: {
                        DemoRow(
                            title: "Forms & Input",
                            description: "Text fields, pickers, and toggles",
                            icon: "rectangle.and.pencil.and.ellipsis"
                        )
                    }

                    NavigationLink {
                        AlertsDemo()
                    } label: {
                        DemoRow(
                            title: "Alerts & Sheets",
                            description: "Modal presentations and dialogs",
                            icon: "exclamationmark.bubble.fill"
                        )
                    }
                }
                .listRowBackground(theme.surface)

                Section(
                    header: Text("Accessibility").font(theme.typography.labelLarge)
                        .foregroundStyle(theme.textSecondary)
                ) {
                    NavigationLink {
                        TapAtTargetsDemo()
                    } label: {
                        DemoRow(
                            title: "Tap At Targets",
                            description: "Measure visual coordinate tap accuracy",
                            icon: "scope"
                        )
                    }

                    NavigationLink {
                        AccessibilityDemo()
                    } label: {
                        DemoRow(
                            title: "Accessibility",
                            description: "VoiceOver and Dynamic Type",
                            icon: "accessibility.fill"
                        )
                    }

                    NavigationLink {
                        AccessibilityRotorDemo()
                    } label: {
                        DemoRow(
                            title: "Custom Rotors",
                            description: "VoiceOver rotor navigation",
                            icon: "dial.medium.fill"
                        )
                    }

                    NavigationLink {
                        SwiftUISemanticLinksDemo()
                    } label: {
                        DemoRow(
                            title: "Semantic Links (SwiftUI)",
                            description: "AttributedString inline accessibility links",
                            icon: "link"
                        )
                    }

                    NavigationLink {
                        UIKitSemanticLinksDemo()
                    } label: {
                        DemoRow(
                            title: "Semantic Links (UIKit)",
                            description: "UITextView inline accessibility links",
                            icon: "link.circle"
                        )
                    }
                }
                .listRowBackground(theme.surface)

                Section(
                    header: Text("View Hierarchy").font(theme.typography.labelLarge)
                        .foregroundStyle(theme.textSecondary)
                ) {
                    NavigationLink {
                        ViewHierarchyDebugDemo()
                    } label: {
                        DemoRow(
                            title: "Hierarchy Debug",
                            description: "Test SDK walker vs accessibility tree",
                            icon: "rectangle.3.group.fill"
                        )
                    }
                }
                .listRowBackground(theme.surface)
            }
            .scrollContentBackground(.hidden)
            .background(theme.background)
            .navigationTitle("Demos")
            .navigationDestination(isPresented: $shouldOpenTapAtTargets) {
                TapAtTargetsDemo()
            }
            .onAppear {
                guard !didCheckDeepLink else { return }
                didCheckDeepLink = true
                shouldOpenTapAtTargets =
                    ProcessInfo.processInfo.environment["PLAYGROUND_DEEP_LINK"] == "tapAtTargets"
            }
            .trackNavigation(destination: "demos", metadata: ["type": "tab_switch"])
        }
    }
}

struct DemoRow: View {
    let title: String
    let description: String
    let icon: String
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(theme.typography.headlineMedium)
                .foregroundStyle(theme.primary)
                .frame(width: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(theme.typography.titleMedium)
                    .foregroundStyle(theme.textPrimary)
                Text(description)
                    .font(theme.typography.labelMedium)
                    .foregroundStyle(theme.textSecondary)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Scroll Performance Demo

struct ScrollPerformanceDemo: View {
    private let items = (1 ... 1000).map { "Item \($0)" }
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        List(items, id: \.self) { item in
            HStack {
                Circle()
                    .fill(theme.primary)
                    .frame(width: 40, height: 40)

                VStack(alignment: .leading) {
                    Text(item)
                        .font(theme.typography.titleMedium)
                        .foregroundStyle(theme.textPrimary)
                    Text("Scroll quickly to test performance")
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(theme.textSecondary)
                }
            }
            .padding(.vertical, 4)
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Scroll Performance")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "ScrollPerformanceDemo")
    }
}

// MARK: - Animation Demo

struct AnimationDemo: View {
    @State private var isAnimating = false
    @State private var rotation: Double = 0
    @State private var scale: CGFloat = 1.0
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(spacing: 40) {
                // Continuous rotation
                VStack(spacing: 8) {
                    Text("Continuous Rotation")
                        .font(theme.typography.titleMedium)
                        .foregroundStyle(theme.textPrimary)

                    Image(systemName: "gear")
                        .font(theme.typography.displayLarge)
                        .foregroundStyle(theme.primary)
                        .rotationEffect(.degrees(rotation))
                        .onAppear {
                            withAnimation(.linear(duration: 2).repeatForever(autoreverses: false)) {
                                rotation = 360
                            }
                        }
                }

                // Scale animation
                VStack(spacing: 8) {
                    Text("Tap to Scale")
                        .font(theme.typography.titleMedium)
                        .foregroundStyle(theme.textPrimary)

                    Circle()
                        .fill(theme.primary)
                        .frame(width: 80, height: 80)
                        .scaleEffect(scale)
                        .onTapGesture {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) {
                                scale = scale == 1.0 ? 1.5 : 1.0
                            }
                        }
                }

                // Toggle animation
                VStack(spacing: 8) {
                    Text("Toggle Animation")
                        .font(theme.typography.titleMedium)
                        .foregroundStyle(theme.textPrimary)

                    theme.shapes.rounded(theme.shapes.small)
                        .fill(isAnimating ? theme.primary : theme.surfaceVariant)
                        .frame(width: isAnimating ? 200 : 100, height: 60)
                        .animation(.easeInOut(duration: 0.5), value: isAnimating)

                    Button(isAnimating ? "Reset" : "Animate") {
                        isAnimating.toggle()
                    }
                    .font(theme.typography.labelLarge)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: theme.shapes.button))
                    .tint(theme.primary)
                }

                Spacer()
            }
            .padding()
        }
        .background(theme.background)
        .navigationTitle("Animations")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "AnimationDemo")
    }
}

// MARK: - Heavy Computation Demo

struct HeavyComputationDemo: View {
    @State private var result = "Tap a button to test"
    @State private var isComputing = false
    @State private var progress: Double = 0
    @State private var selectedDuration = 1.0
    @Environment(\.autoMobileTheme) private var theme

    private let durations: [Double] = [0.5, 1.0, 2.0, 3.0, 5.0]

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Main Thread Blocking Section
                VStack(spacing: 12) {
                    Text("Block Main Thread")
                        .font(theme.typography.headlineMedium)
                        .fontWeight(.bold)
                        .foregroundStyle(theme.textPrimary)

                    Text(
                        "This will freeze the UI completely by sleeping on the main thread. Use this to test jank detection."
                    )
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                    // Duration picker
                    VStack(spacing: 8) {
                        Text("Duration: \(String(format: "%.1f", selectedDuration))s")
                            .font(theme.typography.titleSmall)
                            .foregroundStyle(theme.textSecondary)

                        Picker("Duration", selection: $selectedDuration) {
                            ForEach(durations, id: \.self) { duration in
                                Text("\(String(format: "%.1f", duration))s").tag(duration)
                                    .font(theme.typography.bodyLarge)
                                    .foregroundStyle(theme.textPrimary)
                            }
                        }
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                        .tint(theme.primary)
                        .pickerStyle(.segmented)
                        .padding(.horizontal)
                    }

                    Button {
                        blockMainThread()
                    } label: {
                        Label("Block Main Thread", systemImage: "exclamationmark.triangle.fill")
                            .font(theme.typography.labelLarge)
                            .foregroundStyle(theme.onPrimary)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: theme.shapes.button))
                    .tint(theme.primary)
                }
                .padding()
                .background(theme.primary.opacity(0.1))
                .cornerRadius(theme.shapes.small)

                Divider()
                    .padding(.horizontal)

                // Background Computation Section
                VStack(spacing: 12) {
                    Text("Background Computation")
                        .font(theme.typography.headlineMedium)
                        .fontWeight(.bold)
                        .foregroundStyle(theme.textPrimary)

                    Text("This runs intensive calculations in the background without blocking the UI.")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)

                    ProgressView(value: progress)
                        .padding(.horizontal, 40)
                        .tint(theme.primary)

                    Button {
                        startComputation()
                    } label: {
                        if isComputing {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle())
                        } else {
                            Text("Start Computation")
                                .font(theme.typography.labelLarge)
                                .foregroundStyle(theme.onPrimary)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: theme.shapes.button))
                    .tint(theme.primary)
                    .disabled(isComputing)
                }
                .padding()
                .background(theme.surfaceVariant)
                .cornerRadius(theme.shapes.small)

                // Result display
                Text(result)
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(theme.surfaceVariant)
                    .cornerRadius(theme.shapes.extraSmall)

                Spacer()
            }
            .padding()
        }
        .background(theme.background)
        .navigationTitle("Heavy Computation")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "HeavyComputationDemo")
    }

    private func blockMainThread() {
        result = "Blocking main thread for \(String(format: "%.1f", selectedDuration))s..."

        // This intentionally blocks the main thread to cause jank
        Thread.sleep(forTimeInterval: selectedDuration)

        result = "Main thread blocked for \(String(format: "%.1f", selectedDuration))s"
    }

    private func startComputation() {
        isComputing = true
        progress = 0
        result = "Computing in background..."

        // Run computation on a background queue to avoid blocking the main actor
        DispatchQueue.global(qos: .userInitiated).async {
            var sum: Double = 0
            let iterations = 10_000_000
            let updateInterval = iterations / 100

            for i in 0 ..< iterations {
                sum += sin(Double(i)) * cos(Double(i))

                if i % updateInterval == 0 {
                    let p = Double(i) / Double(iterations)
                    DispatchQueue.main.async {
                        progress = p
                    }
                }
            }

            DispatchQueue.main.async {
                progress = 1.0
                result = String(format: "Computation result: %.6f", sum)
                isComputing = false
            }
        }
    }
}

// MARK: - Form Demo

struct FormDemo: View {
    @Environment(\.autoMobileTheme) private var theme
    @State private var name = ""
    @State private var email = ""
    @State private var enableNotifications = true
    @State private var selectedTheme = "System"
    @State private var volume = 0.5

    private let themes = ["System", "Light", "Dark"]

    var body: some View {
        Form {
            Section(
                header: Text("Personal Information").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                TextField("Name", text: $name)
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                TextField("Email", text: $email)
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
            }
            .listRowBackground(theme.surface)

            Section(
                header: Text("Preferences").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                Toggle("Enable Notifications", isOn: $enableNotifications)
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                    .tint(theme.primary)

                Picker("Theme", selection: $selectedTheme) {
                    ForEach(themes, id: \.self) { option in
                        Text(option)
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textPrimary)
                    }
                }
                .font(theme.typography.bodyLarge)
                .foregroundStyle(theme.textPrimary)
                .tint(theme.primary)

                VStack(alignment: .leading) {
                    Text("Volume: \(Int(volume * 100))%")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Slider(value: $volume)
                }
            }
            .listRowBackground(theme.surface)

            Section {
                Button("Save Changes") {
                    // Save action
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
                .frame(maxWidth: .infinity)
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Forms")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Alerts Demo

struct AlertsDemo: View {
    @Environment(\.autoMobileTheme) private var theme
    @State private var showAlert = false
    @State private var showSheet = false
    @State private var showConfirmation = false

    var body: some View {
        List {
            Section(header: Text("Alerts").font(theme.typography.labelLarge).foregroundStyle(theme.textSecondary)) {
                Button("Show Alert") {
                    showAlert = true
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
                .alert("Alert Title", isPresented: $showAlert) {
                    Button("OK", role: .cancel) {}
                        .font(theme.typography.labelLarge)
                        .foregroundStyle(theme.primary)
                        .tint(theme.primary)
                } message: {
                    Text("This is an alert message.")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                }

                Button("Show Confirmation") {
                    showConfirmation = true
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
                .confirmationDialog("Choose an action", isPresented: $showConfirmation) {
                    Button("Option 1") {}
                        .font(theme.typography.labelLarge)
                        .foregroundStyle(theme.primary)
                        .tint(theme.primary)
                    Button("Option 2") {}
                        .font(theme.typography.labelLarge)
                        .foregroundStyle(theme.primary)
                        .tint(theme.primary)
                    Button("Delete", role: .destructive) {}
                        .font(theme.typography.labelLarge)
                        .foregroundStyle(theme.primary)
                        .tint(theme.primary)
                    Button("Cancel", role: .cancel) {}
                        .font(theme.typography.labelLarge)
                        .foregroundStyle(theme.primary)
                        .tint(theme.primary)
                }
            }
            .listRowBackground(theme.surface)

            Section(header: Text("Sheets").font(theme.typography.labelLarge).foregroundStyle(theme.textSecondary)) {
                Button("Show Sheet") {
                    showSheet = true
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
                .sheet(isPresented: $showSheet) {
                    SheetContent()
                }
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Alerts & Sheets")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct SheetContent: View {
    @Environment(\.dismiss) var dismiss
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text("This is a sheet")
                    .foregroundStyle(theme.textPrimary)
                    .font(theme.typography.headlineLarge)

                Text("Swipe down or tap Done to dismiss")
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textSecondary)
            }
            .font(theme.typography.bodyLarge)
            .foregroundStyle(theme.textPrimary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.background)
            .navigationTitle("Sheet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .font(theme.typography.labelLarge)
                    .foregroundStyle(theme.primary)
                    .tint(theme.primary)
                }
            }
        }
    }
}

// MARK: - Accessibility Demo

struct AccessibilityDemo: View {
    @State private var dynamicTypeSize: DynamicTypeSize = .large
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        List {
            Section {
                Text("Dynamic Type Preview")
                    .font(theme.typography.titleMedium)
                    .foregroundStyle(theme.textPrimary)

                Text(
                    "This text will scale with Dynamic Type settings. Try changing the text size in Settings > Accessibility > Display & Text Size."
                )
                .font(theme.typography.bodyLarge)
                .dynamicTypeSize(dynamicTypeSize)
                .foregroundStyle(theme.textSecondary)
            }
            .listRowBackground(theme.surface)

            Section(
                header: Text("VoiceOver Labels").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                HStack {
                    Image(systemName: "star.fill")
                        .foregroundStyle(theme.warning)
                        .accessibilityLabel("Favorite")

                    Text("Favorite Item")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)

                    Spacer()

                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(theme.success)
                        .accessibilityLabel("Completed")
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Favorite Item, Completed")

                Button {
                    // Action
                } label: {
                    HStack {
                        Image(systemName: "plus")
                        Text("Add Item")
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textPrimary)
                    }
                }
                .tint(theme.primary)
                .accessibilityHint("Double tap to add a new item")
            }
            .listRowBackground(theme.surface)

            Section(
                header: Text("AutoMobile Colors").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                HStack {
                    Rectangle()
                        .fill(Color.autoMobileLalala)
                        .frame(width: 40, height: 40)
                        .cornerRadius(theme.shapes.extraSmall)
                    Text("Primary (Lalala)")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                }

                HStack {
                    Rectangle()
                        .fill(theme.primary)
                        .frame(width: 40, height: 40)
                        .cornerRadius(theme.shapes.extraSmall)
                    Text("Secondary (Red)")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                }

                HStack {
                    Rectangle()
                        .fill(Color.autoMobileEggshell)
                        .frame(width: 40, height: 40)
                        .cornerRadius(theme.shapes.extraSmall)
                        .overlay(
                            theme.shapes.rounded(theme.shapes.extraSmall)
                                .stroke(Color.autoMobileLightGrey, lineWidth: 1)
                        )
                    Text("Background (Eggshell)")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                }
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Accessibility")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - SDK Status Demo

struct SDKStatusDemo: View {
    @State private var sdkEnabled: Bool = AutoMobileSDK.shared.isEnabled
    @State private var eventName = ""
    @State private var eventProperty = ""
    @State private var statusMessage = ""
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        List {
            Section(header: Text("SDK State").font(theme.typography.labelLarge).foregroundStyle(theme.textSecondary)) {
                HStack {
                    Text("Initialized")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Spacer()
                    Text(AutoMobileSDK.shared.isInitialized ? "Yes" : "No")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(AutoMobileSDK.shared.isInitialized ? theme.success : theme.textSecondary)
                }

                HStack {
                    Text("Bundle ID")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Spacer()
                    Text(AutoMobileSDK.shared.bundleId ?? "N/A")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textSecondary)
                        .lineLimit(1)
                }

                Toggle("Enabled", isOn: $sdkEnabled)
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                    .tint(theme.primary)
                    .onChange(of: sdkEnabled) { _, newValue in
                        AutoMobileSDK.shared.setEnabled(newValue)
                    }

                HStack {
                    Text("Navigation Listeners")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Spacer()
                    Text("\(AutoMobileSDK.shared.listenerCount)")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textSecondary)
                }
            }
            .listRowBackground(theme.surface)

            Section(
                header: Text("Log Message").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                TextField("Event Name", text: $eventName)
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                TextField("Property (key=value)", text: $eventProperty)
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)

                Button("Log Event") {
                    var message = eventName
                    if eventProperty.contains("=") {
                        message += " \(eventProperty)"
                    }
                    AutoMobileLog.shared.i("DemosTab", message)
                    statusMessage = "Logged: \(eventName)"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
                .disabled(eventName.isEmpty)

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .foregroundStyle(theme.success)
                        .font(theme.typography.labelMedium)
                }
            }
            .listRowBackground(theme.surface)

            Section(
                header: Text("Storage Inspection").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                HStack {
                    Text("UserDefaults Inspector")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Spacer()
                    Text(UserDefaultsInspector.shared.isEnabled ? "Enabled" : "Disabled")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(UserDefaultsInspector.shared.isEnabled ? theme.success : theme.textSecondary)
                }

                HStack {
                    Text("Database Inspector")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Spacer()
                    Text(DatabaseInspector.shared.isEnabled ? "Enabled" : "Disabled")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(DatabaseInspector.shared.isEnabled ? theme.success : theme.textSecondary)
                }
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("SDK Status")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "SDKStatusDemo")
    }
}

// MARK: - Error Tracking Demo

struct ErrorTrackingDemo: View {
    @State private var errorCount = 0
    @State private var lastError = ""
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        List {
            Section(
                header: Text("Handled Exceptions").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                HStack {
                    Text("Recorded Errors")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Spacer()
                    Text("\(AutoMobileFailures.shared.eventCount)")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textSecondary)
                }

                Button("Record Test Error") {
                    let error = NSError(
                        domain: "PlaygroundDemo",
                        code: 1001,
                        userInfo: [NSLocalizedDescriptionKey: "Demo error for testing"]
                    )
                    AutoMobileFailures.shared.recordHandledException(
                        error,
                        message: "Triggered from demo",
                        currentScreen: "ErrorTrackingDemo"
                    )
                    errorCount = AutoMobileFailures.shared.eventCount
                    lastError = "PlaygroundDemo:1001"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)

                Button("Record Network Error") {
                    let error = NSError(
                        domain: NSURLErrorDomain,
                        code: NSURLErrorTimedOut,
                        userInfo: [NSLocalizedDescriptionKey: "The request timed out"]
                    )
                    AutoMobileFailures.shared.recordHandledException(
                        error,
                        message: "API call failed",
                        currentScreen: "ErrorTrackingDemo"
                    )
                    errorCount = AutoMobileFailures.shared.eventCount
                    lastError = "NSURLErrorDomain:\(NSURLErrorTimedOut)"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)

                if !lastError.isEmpty {
                    Text("Last: \(lastError)")
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(theme.error)
                }
            }
            .listRowBackground(theme.surface)

            Section(
                header: Text("Recent Events").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                let events = AutoMobileFailures.shared.getRecentEvents()
                if events.isEmpty {
                    Text("No errors recorded")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textSecondary)
                } else {
                    ForEach(events.suffix(5).reversed(), id: \.timestamp) { event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.errorDomain)
                                .font(theme.typography.titleMedium)
                                .foregroundStyle(theme.textPrimary)
                            if let msg = event.customMessage {
                                Text(msg)
                                    .font(theme.typography.labelMedium)
                                    .foregroundStyle(theme.textSecondary)
                            }
                        }
                    }
                }
            }
            .listRowBackground(theme.surface)

            Section {
                Button("Clear All Events", role: .destructive) {
                    AutoMobileFailures.shared.clearEvents()
                    errorCount = 0
                    lastError = ""
                }
                .font(theme.typography.labelLarge)
                .tint(theme.primary)
                .foregroundStyle(theme.primary)
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Error Tracking")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "ErrorTrackingDemo")
    }
}

// MARK: - Biometrics Demo

struct BiometricsDemo: View {
    @State private var selectedResult = "success"
    @State private var statusMessage = ""
    @Environment(\.autoMobileTheme) private var theme

    private let resultOptions = ["success", "failure", "cancel", "error"]

    var body: some View {
        List {
            Section(
                header: Text("Override Biometric Result").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                Picker("Result", selection: $selectedResult) {
                    ForEach(resultOptions, id: \.self) { option in
                        Text(option.capitalized).tag(option)
                            .font(theme.typography.bodyLarge)
                            .foregroundStyle(theme.textPrimary)
                    }
                }
                .font(theme.typography.bodyLarge)
                .foregroundStyle(theme.textPrimary)
                .tint(theme.primary)
                .pickerStyle(.segmented)

                Button("Set Override") {
                    let result: BiometricResult
                    switch selectedResult {
                    case "success": result = .success
                    case "failure": result = .failure
                    case "cancel": result = .cancel
                    default: result = .error(code: 7, message: "Too many attempts")
                    }
                    AutoMobileBiometrics.shared.overrideResult(result)
                    statusMessage = "Override set: \(selectedResult)"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)

                Button("Consume Override") {
                    if let result = AutoMobileBiometrics.shared.consumeOverride() {
                        statusMessage = "Consumed: \(result)"
                    } else {
                        statusMessage = "No override available"
                    }
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)

                Button("Clear Override") {
                    AutoMobileBiometrics.shared.clearOverride()
                    statusMessage = "Override cleared"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
            }
            .listRowBackground(theme.surface)

            Section(header: Text("Status").font(theme.typography.labelLarge).foregroundStyle(theme.textSecondary)) {
                HStack {
                    Text("Has Override")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Spacer()
                    Text(AutoMobileBiometrics.shared.hasOverride ? "Yes" : "No")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(AutoMobileBiometrics.shared.hasOverride ? theme.success : theme.textSecondary)
                }

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(theme.info)
                }
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Biometrics")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "BiometricsDemo")
    }
}

// MARK: - Network Tracking Demo

struct NetworkTrackingDemo: View {
    @State private var requestCount = 0
    @State private var lastRequest = ""
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        List {
            Section(
                header: Text("Manual Recording").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                Button("Record GET Request") {
                    AutoMobileNetwork.shared.recordRequest(
                        url: "https://api.example.com/users",
                        method: "GET",
                        statusCode: 200,
                        responseBodySize: 2048,
                        durationMs: 150.0
                    )
                    requestCount += 1
                    lastRequest = "GET /users → 200"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)

                Button("Record POST Request") {
                    AutoMobileNetwork.shared.recordRequest(
                        url: "https://api.example.com/posts",
                        method: "POST",
                        requestBodySize: 512,
                        statusCode: 201,
                        responseBodySize: 128,
                        durationMs: 250.0
                    )
                    requestCount += 1
                    lastRequest = "POST /posts → 201"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)

                Button("Record Failed Request") {
                    AutoMobileNetwork.shared.recordRequest(
                        url: "https://api.example.com/timeout",
                        method: "GET",
                        durationMs: 30000.0,
                        error: "The request timed out"
                    )
                    requestCount += 1
                    lastRequest = "GET /timeout → Error"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
            }
            .listRowBackground(theme.surface)

            Section(
                header: Text("WebSocket Events").font(theme.typography.labelLarge)
                    .foregroundStyle(theme.textSecondary)
            ) {
                Button("Record WebSocket Frame") {
                    AutoMobileNetwork.shared.recordWebSocketFrame(
                        url: "wss://ws.example.com/stream",
                        direction: .received,
                        frameType: .text,
                        payloadSize: 1024
                    )
                    requestCount += 1
                    lastRequest = "WS frame received (1024 bytes)"
                }
                .font(theme.typography.labelLarge)
                .foregroundStyle(theme.primary)
                .tint(theme.primary)
            }
            .listRowBackground(theme.surface)

            Section(header: Text("Status").font(theme.typography.labelLarge).foregroundStyle(theme.textSecondary)) {
                HStack {
                    Text("Events Recorded")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                    Spacer()
                    Text("\(requestCount)")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textSecondary)
                }

                if !lastRequest.isEmpty {
                    Text(lastRequest)
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(theme.info)
                }
            }
            .listRowBackground(theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle("Network Tracking")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "NetworkTrackingDemo")
    }
}

// MARK: - View Hierarchy Debug Demo

/// Demo screen that exercises cases where the SDK's in-process view walker
/// reveals information the accessibility hierarchy hides or flattens.
struct ViewHierarchyDebugDemo: View {
    @State private var tapCount = 0
    @State private var longPressCount = 0
    @State private var swipeDirection = "none"
    @State private var sliderValue = 0.5
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // 1. Combined accessibility element — hides children from a11y tree
                combinedElementSection

                // 2. Custom accessibility actions — only visible in SDK walker
                customActionsSection

                // 3. Multiple gesture recognizers on one view
                gestureRecognizerSection

                // 4. Nested opaque views with layered backgrounds
                layeredViewsSection

                // 5. Hidden views that are invisible to a11y but exist in UIView tree
                hiddenViewsSection

                // 6. UIKit representable with tap targets
                uiKitControlSection

                Spacer()
            }
            .padding()
        }
        .background(theme.background)
        .navigationTitle("Hierarchy Debug")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "ViewHierarchyDebugDemo")
    }

    // MARK: - Section 1: Combined Accessibility Element

    private var combinedElementSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Combined Element")
                .font(theme.typography.titleMedium)
                .foregroundStyle(theme.textPrimary)
            Text("Accessibility sees one element; SDK walker sees the children.")
                .font(theme.typography.labelMedium)
                .foregroundStyle(theme.textSecondary)

            HStack(spacing: 12) {
                Image(systemName: "photo.fill")
                    .font(theme.typography.displaySmall)
                    .foregroundStyle(theme.primary)
                    .accessibilityIdentifier("combined-image")

                VStack(alignment: .leading, spacing: 4) {
                    Text("Photo Title")
                        .font(theme.typography.bodyLarge)
                        .foregroundStyle(theme.textPrimary)
                        .accessibilityIdentifier("combined-title")
                    Text("Subtitle with details")
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(theme.textSecondary)
                        .accessibilityIdentifier("combined-subtitle")
                    HStack(spacing: 4) {
                        Image(systemName: "star.fill")
                            .font(theme.typography.labelSmall)
                            .foregroundStyle(theme.warning)
                        Text("4.8")
                            .font(theme.typography.labelSmall)
                            .foregroundStyle(theme.textSecondary)
                        Text("(128 reviews)")
                            .font(theme.typography.labelSmall)
                            .foregroundStyle(theme.textSecondary)
                    }
                    .accessibilityIdentifier("combined-rating")
                }
            }
            .padding()
            .background(theme.surfaceVariant)
            .cornerRadius(theme.shapes.small)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("combined-card")
            .accessibilityLabel("Photo Title, 4.8 stars, 128 reviews")
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(theme.shapes.small)
    }

    // MARK: - Section 2: Custom Accessibility Actions

    private var customActionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Custom Actions")
                .font(theme.typography.titleMedium)
                .foregroundStyle(theme.textPrimary)
            Text("Accessibility custom actions are only visible through the SDK walker.")
                .font(theme.typography.labelMedium)
                .foregroundStyle(theme.textSecondary)

            VStack(spacing: 12) {
                Text("Message from Alice")
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                Text("Hey, want to grab lunch tomorrow?")
                    .font(theme.typography.titleSmall)
                    .foregroundStyle(theme.textSecondary)
                Text("Tap count: \(tapCount)")
                    .font(theme.typography.labelMedium)
                    .foregroundStyle(theme.textSecondary)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surfaceVariant)
            .cornerRadius(theme.shapes.small)
            .accessibilityIdentifier("message-cell")
            .accessibilityElement(children: .combine)
            .accessibilityAction(named: "Reply") { tapCount += 1 }
            .accessibilityAction(named: "Forward") { tapCount += 1 }
            .accessibilityAction(named: "Mark as Unread") { tapCount += 1 }
            .accessibilityAction(named: "Delete") { tapCount += 1 }
            .accessibilityAction(named: "Archive") { tapCount += 1 }
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(theme.shapes.small)
    }

    // MARK: - Section 3: Gesture Recognizers

    private var gestureRecognizerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Gesture Recognizers")
                .font(theme.typography.titleMedium)
                .foregroundStyle(theme.textPrimary)
            Text("SDK walker shows gesture types; accessibility only reports 'button' trait.")
                .font(theme.typography.labelMedium)
                .foregroundStyle(theme.textSecondary)

            VStack(spacing: 4) {
                Text("Tap, Long Press, or Swipe")
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                Text("Taps: \(tapCount)  Long Presses: \(longPressCount)  Swipe: \(swipeDirection)")
                    .font(theme.typography.labelMedium)
                    .foregroundStyle(theme.textSecondary)
            }
            .padding(40)
            .frame(maxWidth: .infinity)
            .background(theme.primary.opacity(0.15))
            .cornerRadius(theme.shapes.medium)
            .accessibilityIdentifier("gesture-target")
            .onTapGesture { tapCount += 1 }
            .onLongPressGesture { longPressCount += 1 }
            .gesture(
                DragGesture(minimumDistance: 30)
                    .onEnded { value in
                        let h = value.translation.width
                        let v = value.translation.height
                        if abs(h) > abs(v) {
                            swipeDirection = h > 0 ? "right" : "left"
                        } else {
                            swipeDirection = v > 0 ? "down" : "up"
                        }
                    }
            )
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(theme.shapes.small)
    }

    // MARK: - Section 4: Layered Views

    private var layeredViewsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Layered Views")
                .font(theme.typography.titleMedium)
                .foregroundStyle(theme.textPrimary)
            Text("SDK walker reveals z-order, alpha, background colors, and corner radii.")
                .font(theme.typography.labelMedium)
                .foregroundStyle(theme.textSecondary)

            ZStack {
                theme.shapes.rounded(theme.shapes.medium)
                    .fill(theme.primary.opacity(0.3))
                    .frame(width: 200, height: 200)
                    .accessibilityIdentifier("layer-back")

                theme.shapes.rounded(theme.shapes.medium)
                    .fill(theme.warning.opacity(0.5))
                    .frame(width: 150, height: 150)
                    .accessibilityIdentifier("layer-middle")

                theme.shapes.rounded(theme.shapes.small)
                    .fill(theme.primary.opacity(0.7))
                    .frame(width: 100, height: 100)
                    .accessibilityIdentifier("layer-front")

                Text("Top")
                    .font(theme.typography.titleMedium)
                    .foregroundStyle(theme.onPrimary)
                    .accessibilityIdentifier("layer-label")
            }
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("layered-stack")
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(theme.shapes.small)
    }

    // MARK: - Section 5: Hidden Views

    private var hiddenViewsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Hidden & Decorative Views")
                .font(theme.typography.titleMedium)
                .foregroundStyle(theme.textPrimary)
            Text(
                "Views with accessibilityHidden or zero alpha exist in the UIView tree but not the accessibility tree."
            )
            .font(theme.typography.labelMedium)
            .foregroundStyle(theme.textSecondary)

            VStack(spacing: 12) {
                Text("Visible content")
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                    .accessibilityIdentifier("visible-text")

                Text("A11y-hidden content")
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.primary)
                    .accessibilityIdentifier("a11y-hidden-text")
                    .accessibilityHidden(true)

                Text("Elements-hidden container child")
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.warning)
                    .accessibilityIdentifier("elements-hidden-child")

                // Decorative divider — no a11y representation
                Rectangle()
                    .fill(
                        LinearGradient(
                            colors: [.clear, theme.primary, .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(height: 2)
                    .accessibilityIdentifier("decorative-divider")
                    .accessibilityHidden(true)

                Text("Below the decorative divider")
                    .font(theme.typography.bodyLarge)
                    .foregroundStyle(theme.textPrimary)
                    .accessibilityIdentifier("below-divider-text")
            }
            .padding()
            .background(theme.surfaceVariant)
            .cornerRadius(theme.shapes.small)
            .accessibilityIdentifier("hidden-views-container")
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(theme.shapes.small)
    }

    // MARK: - Section 6: UIKit Control

    private var uiKitControlSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("UIKit Controls in SwiftUI")
                .font(theme.typography.titleMedium)
                .foregroundStyle(theme.textPrimary)
            Text("UIViewRepresentable wraps real UIKit controls — SDK walker sees UIControl targets and actions.")
                .font(theme.typography.labelMedium)
                .foregroundStyle(theme.textSecondary)

            StepperControlView(value: $sliderValue)
                .frame(height: 44)
                .accessibilityIdentifier("uikit-stepper")

            Text("Value: \(String(format: "%.1f", sliderValue))")
                .font(theme.typography.labelMedium)
                .foregroundStyle(theme.textSecondary)

            SegmentedControlView()
                .frame(height: 44)
                .accessibilityIdentifier("uikit-segmented")
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(theme.shapes.small)
    }
}

// MARK: - UIKit Representables

struct StepperControlView: UIViewRepresentable {
    @Environment(\.autoMobileTheme) private var theme
    @Binding var value: Double

    func makeUIView(context: Context) -> UIStepper {
        let stepper = UIStepper()
        stepper.minimumValue = 0
        stepper.maximumValue = 10
        stepper.stepValue = 0.5
        stepper.value = value
        stepper.accessibilityIdentifier = "uikit-stepper-control"
        stepper.addTarget(context.coordinator, action: #selector(Coordinator.valueChanged(_:)), for: .valueChanged)
        return stepper
    }

    func updateUIView(_ uiView: UIStepper, context _: Context) {
        uiView.tintColor = UIColor(theme.primary)
        uiView.value = value
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(value: $value)
    }

    class Coordinator: NSObject {
        var value: Binding<Double>
        init(value: Binding<Double>) { self.value = value }

        @objc
        func valueChanged(_ sender: UIStepper) {
            value.wrappedValue = sender.value
        }
    }
}

struct SegmentedControlView: UIViewRepresentable {
    @Environment(\.autoMobileTheme) private var theme
    func makeUIView(context _: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: ["Low", "Medium", "High"])
        control.selectedSegmentIndex = 1
        control.accessibilityIdentifier = "uikit-segmented-control"
        return control
    }

    func updateUIView(_ uiView: UISegmentedControl, context _: Context) {
        uiView.backgroundColor = UIColor(theme.surfaceVariant)
        uiView.selectedSegmentTintColor = UIColor(theme.primary)
        uiView.setTitleTextAttributes([
            .font: theme.typography.uiKitLabelLarge,
            .foregroundColor: UIColor(theme.textPrimary),
        ], for: .normal)
        uiView.setTitleTextAttributes([
            .font: theme.typography.uiKitLabelLarge,
            .foregroundColor: UIColor(theme.onPrimary),
        ], for: .selected)
    }
}

#Preview {
    DemosTab()
        .autoMobileTheme()
}
