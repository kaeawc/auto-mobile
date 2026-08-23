import AutoMobileSDK
import SwiftUI

struct DemosTab: View {
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        NavigationStack {
            List {
                Section("SDK Features") {
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

                Section("Performance") {
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

                Section("UI Components") {
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

                Section("Accessibility") {
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

                Section("View Hierarchy") {
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
            }
            .navigationTitle("Demos")
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
                        .font(.system(size: 60))
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

                    RoundedRectangle(cornerRadius: 12)
                        .fill(isAnimating ? theme.primary : Color.autoMobileDarkGrey)
                        .frame(width: isAnimating ? 200 : 100, height: 60)
                        .animation(.easeInOut(duration: 0.5), value: isAnimating)

                    Button(isAnimating ? "Reset" : "Animate") {
                        isAnimating.toggle()
                    }
                    .buttonStyle(.borderedProminent)
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
                            }
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal)
                    }

                    Button {
                        blockMainThread()
                    } label: {
                        Label("Block Main Thread", systemImage: "exclamationmark.triangle.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(theme.primary)
                }
                .padding()
                .background(theme.primary.opacity(0.1))
                .cornerRadius(12)

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
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(theme.primary)
                    .disabled(isComputing)
                }
                .padding()
                .background(theme.surfaceVariant)
                .cornerRadius(12)

                // Result display
                Text(result)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(theme.textPrimary)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(theme.surfaceVariant)
                    .cornerRadius(8)

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
            Section("Personal Information") {
                TextField("Name", text: $name)
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
            }

            Section("Preferences") {
                Toggle("Enable Notifications", isOn: $enableNotifications)

                Picker("Theme", selection: $selectedTheme) {
                    ForEach(themes, id: \.self) { theme in
                        Text(theme)
                    }
                }

                VStack(alignment: .leading) {
                    Text("Volume: \(Int(volume * 100))%")
                    Slider(value: $volume)
                }
            }

            Section {
                Button("Save Changes") {
                    // Save action
                }
                .frame(maxWidth: .infinity)
            }
        }
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
            Section("Alerts") {
                Button("Show Alert") {
                    showAlert = true
                }
                .alert("Alert Title", isPresented: $showAlert) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text("This is an alert message.")
                }

                Button("Show Confirmation") {
                    showConfirmation = true
                }
                .confirmationDialog("Choose an action", isPresented: $showConfirmation) {
                    Button("Option 1") {}
                    Button("Option 2") {}
                    Button("Delete", role: .destructive) {}
                    Button("Cancel", role: .cancel) {}
                }
            }

            Section("Sheets") {
                Button("Show Sheet") {
                    showSheet = true
                }
                .sheet(isPresented: $showSheet) {
                    SheetContent()
                }
            }
        }
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
                    .font(theme.typography.headlineLarge)

                Text("Swipe down or tap Done to dismiss")
                    .foregroundStyle(theme.textSecondary)
            }
            .navigationTitle("Sheet")
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
                .dynamicTypeSize(dynamicTypeSize)
                .foregroundStyle(theme.textSecondary)
            }

            Section("VoiceOver Labels") {
                HStack {
                    Image(systemName: "star.fill")
                        .foregroundStyle(Color.autoMobileWarning)
                        .accessibilityLabel("Favorite")

                    Text("Favorite Item")
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
                    }
                }
                .tint(theme.primary)
                .accessibilityHint("Double tap to add a new item")
            }

            Section("AutoMobile Colors") {
                HStack {
                    Rectangle()
                        .fill(Color.autoMobileLalala)
                        .frame(width: 40, height: 40)
                        .cornerRadius(4)
                    Text("Primary (Lalala)")
                        .foregroundStyle(theme.textPrimary)
                }

                HStack {
                    Rectangle()
                        .fill(theme.primary)
                        .frame(width: 40, height: 40)
                        .cornerRadius(4)
                    Text("Secondary (Red)")
                        .foregroundStyle(theme.textPrimary)
                }

                HStack {
                    Rectangle()
                        .fill(Color.autoMobileEggshell)
                        .frame(width: 40, height: 40)
                        .cornerRadius(4)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(Color.autoMobileLightGrey, lineWidth: 1)
                        )
                    Text("Background (Eggshell)")
                        .foregroundStyle(theme.textPrimary)
                }
            }
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
            Section("SDK State") {
                HStack {
                    Text("Initialized")
                    Spacer()
                    Text(AutoMobileSDK.shared.isInitialized ? "Yes" : "No")
                        .foregroundStyle(AutoMobileSDK.shared.isInitialized ? theme.success : theme.textSecondary)
                }

                HStack {
                    Text("Bundle ID")
                    Spacer()
                    Text(AutoMobileSDK.shared.bundleId ?? "N/A")
                        .foregroundStyle(theme.textSecondary)
                        .lineLimit(1)
                }

                Toggle("Enabled", isOn: $sdkEnabled)
                    .onChange(of: sdkEnabled) { _, newValue in
                        AutoMobileSDK.shared.setEnabled(newValue)
                    }

                HStack {
                    Text("Navigation Listeners")
                    Spacer()
                    Text("\(AutoMobileSDK.shared.listenerCount)")
                        .foregroundStyle(theme.textSecondary)
                }
            }

            Section("Log Message") {
                TextField("Event Name", text: $eventName)
                TextField("Property (key=value)", text: $eventProperty)

                Button("Log Event") {
                    var message = eventName
                    if eventProperty.contains("=") {
                        message += " \(eventProperty)"
                    }
                    AutoMobileLog.shared.i("DemosTab", message)
                    statusMessage = "Logged: \(eventName)"
                }
                .disabled(eventName.isEmpty)

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .foregroundStyle(theme.success)
                        .font(theme.typography.labelMedium)
                }
            }

            Section("Storage Inspection") {
                HStack {
                    Text("UserDefaults Inspector")
                    Spacer()
                    Text(UserDefaultsInspector.shared.isEnabled ? "Enabled" : "Disabled")
                        .foregroundStyle(UserDefaultsInspector.shared.isEnabled ? theme.success : theme.textSecondary)
                }

                HStack {
                    Text("Database Inspector")
                    Spacer()
                    Text(DatabaseInspector.shared.isEnabled ? "Enabled" : "Disabled")
                        .foregroundStyle(DatabaseInspector.shared.isEnabled ? theme.success : theme.textSecondary)
                }
            }
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
            Section("Handled Exceptions") {
                HStack {
                    Text("Recorded Errors")
                    Spacer()
                    Text("\(AutoMobileFailures.shared.eventCount)")
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

                if !lastError.isEmpty {
                    Text("Last: \(lastError)")
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(Color.autoMobileError)
                }
            }

            Section("Recent Events") {
                let events = AutoMobileFailures.shared.getRecentEvents()
                if events.isEmpty {
                    Text("No errors recorded")
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

            Section {
                Button("Clear All Events", role: .destructive) {
                    AutoMobileFailures.shared.clearEvents()
                    errorCount = 0
                    lastError = ""
                }
                .foregroundStyle(theme.primary)
            }
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
            Section("Override Biometric Result") {
                Picker("Result", selection: $selectedResult) {
                    ForEach(resultOptions, id: \.self) { option in
                        Text(option.capitalized).tag(option)
                    }
                }
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

                Button("Consume Override") {
                    if let result = AutoMobileBiometrics.shared.consumeOverride() {
                        statusMessage = "Consumed: \(result)"
                    } else {
                        statusMessage = "No override available"
                    }
                }

                Button("Clear Override") {
                    AutoMobileBiometrics.shared.clearOverride()
                    statusMessage = "Override cleared"
                }
            }

            Section("Status") {
                HStack {
                    Text("Has Override")
                    Spacer()
                    Text(AutoMobileBiometrics.shared.hasOverride ? "Yes" : "No")
                        .foregroundStyle(AutoMobileBiometrics.shared.hasOverride ? theme.success : theme.textSecondary)
                }

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(Color.autoMobileInfo)
                }
            }
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
            Section("Manual Recording") {
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
            }

            Section("WebSocket Events") {
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
            }

            Section("Status") {
                HStack {
                    Text("Events Recorded")
                    Spacer()
                    Text("\(requestCount)")
                        .foregroundStyle(theme.textSecondary)
                }

                if !lastRequest.isEmpty {
                    Text(lastRequest)
                        .font(theme.typography.labelMedium)
                        .foregroundStyle(Color.autoMobileInfo)
                }
            }
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
                            .foregroundStyle(Color.autoMobileWarning)
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
            .cornerRadius(12)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("combined-card")
            .accessibilityLabel("Photo Title, 4.8 stars, 128 reviews")
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(12)
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
            .cornerRadius(12)
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
        .cornerRadius(12)
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
            .cornerRadius(16)
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
        .cornerRadius(12)
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
                RoundedRectangle(cornerRadius: 20)
                    .fill(theme.primary.opacity(0.3))
                    .frame(width: 200, height: 200)
                    .accessibilityIdentifier("layer-back")

                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.autoMobileWarning.opacity(0.5))
                    .frame(width: 150, height: 150)
                    .accessibilityIdentifier("layer-middle")

                RoundedRectangle(cornerRadius: 12)
                    .fill(theme.primary.opacity(0.7))
                    .frame(width: 100, height: 100)
                    .accessibilityIdentifier("layer-front")

                Text("Top")
                    .font(theme.typography.titleMedium)
                    .foregroundStyle(.white)
                    .accessibilityIdentifier("layer-label")
            }
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("layered-stack")
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(12)
    }

    // MARK: - Section 5: Hidden Views

    private var hiddenViewsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Hidden & Decorative Views")
                .font(theme.typography.titleMedium)
                .foregroundStyle(theme.textPrimary)
            Text("Views with accessibilityHidden or zero alpha exist in the UIView tree but not the accessibility tree.")
                .font(theme.typography.labelMedium)
                .foregroundStyle(theme.textSecondary)

            VStack(spacing: 12) {
                Text("Visible content")
                    .foregroundStyle(theme.textPrimary)
                    .accessibilityIdentifier("visible-text")

                Text("A11y-hidden content")
                    .foregroundStyle(theme.primary)
                    .accessibilityIdentifier("a11y-hidden-text")
                    .accessibilityHidden(true)

                Text("Elements-hidden container child")
                    .foregroundStyle(Color.autoMobileWarning)
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
                    .foregroundStyle(theme.textPrimary)
                    .accessibilityIdentifier("below-divider-text")
            }
            .padding()
            .background(theme.surfaceVariant)
            .cornerRadius(12)
            .accessibilityIdentifier("hidden-views-container")
        }
        .padding()
        .background(theme.surfaceVariant.opacity(0.3))
        .cornerRadius(12)
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
        .cornerRadius(12)
    }
}

// MARK: - UIKit Representables

struct StepperControlView: UIViewRepresentable {
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

    func updateUIView(_ uiView: UIStepper, context: Context) {
        uiView.value = value
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(value: $value)
    }

    class Coordinator: NSObject {
        var value: Binding<Double>
        init(value: Binding<Double>) { self.value = value }

        @objc func valueChanged(_ sender: UIStepper) {
            value.wrappedValue = sender.value
        }
    }
}

struct SegmentedControlView: UIViewRepresentable {
    func makeUIView(context: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: ["Low", "Medium", "High"])
        control.selectedSegmentIndex = 1
        control.accessibilityIdentifier = "uikit-segmented-control"
        return control
    }

    func updateUIView(_ uiView: UISegmentedControl, context: Context) {}
}

#Preview {
    DemosTab()
        .autoMobileTheme()
}
