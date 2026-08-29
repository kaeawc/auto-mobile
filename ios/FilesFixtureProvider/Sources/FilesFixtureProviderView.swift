import CryptoKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct FilesFixtureProviderView: View {
    @State private var selectedFixture = "No fixture selected"
    @State private var showingPicker = false

    var body: some View {
        VStack(spacing: 16) {
            Text("AutoMobile Files")
                .font(.title2)
            Text("Fixtures are bounded to an AutoMobile-owned namespace in this app's Documents directory.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Open document picker") {
                showingPicker = true
            }
            .accessibilityIdentifier("open-document-picker")
            .buttonStyle(.borderedProminent)
            Text(selectedFixture)
                .accessibilityIdentifier("selected-document")
        }
        .padding()
        .sheet(isPresented: $showingPicker) {
            FilesPickerController(
                selectedFixture: $selectedFixture,
                isPresented: $showingPicker
            )
        }
    }
}

private struct FilesPickerController: UIViewControllerRepresentable {
    @Binding var selectedFixture: String
    @Binding var isPresented: Bool

    func makeUIViewController(context _: Context) -> FilesPickerHostViewController {
        FilesPickerHostViewController(
            didSelectFixture: { selectedFixture = $0 },
            didClose: { isPresented = false }
        )
    }

    func updateUIViewController(_: FilesPickerHostViewController, context _: Context) {}
}

private final class FilesPickerHostViewController: UIViewController, UIDocumentPickerDelegate {
    private let didSelectFixture: (String) -> Void
    private let didClose: () -> Void
    private var didPresentPicker = false

    init(
        didSelectFixture: @escaping (String) -> Void,
        didClose: @escaping () -> Void
    ) {
        self.didSelectFixture = didSelectFixture
        self.didClose = didClose
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !didPresentPicker else { return }
        didPresentPicker = true

        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.plainText, .pdf])
        picker.delegate = self
        picker.directoryURL = fixtureDirectory()
        present(picker, animated: false)
    }

    func documentPicker(
        _: UIDocumentPickerViewController,
        didPickDocumentsAt urls: [URL]
    ) {
        guard let selected = urls.first else {
            didClose()
            return
        }
        recordPickerVisibility(selected)
        didSelectFixture(selected.lastPathComponent)
        didClose()
    }

    func documentPickerWasCancelled(_: UIDocumentPickerViewController) {
        didClose()
    }

    private func fixtureDirectory() -> URL? {
        guard let documents = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first else {
            return nil
        }
        let namespace = ProcessInfo.processInfo.environment["AUTOMOBILE_FIXTURE_NAMESPACE"]
        let managedRoot = documents.appendingPathComponent("automobile", isDirectory: true)
        return namespace.map { managedRoot.appendingPathComponent($0, isDirectory: true) }
            ?? managedRoot
    }

    private func recordPickerVisibility(_ selected: URL) {
        let fileManager = FileManager.default
        guard let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
        else { return }
        let managedRoot = documents.appendingPathComponent("automobile", isDirectory: true)
            .standardizedFileURL
        let selectedURL = selected.standardizedFileURL
        let rootPath = managedRoot.path.hasSuffix("/") ? managedRoot.path : managedRoot.path + "/"
        guard selectedURL.path.hasPrefix(rootPath) else { return }
        let relativePath = String(selectedURL.path.dropFirst(rootPath.count))
        let components = relativePath.split(separator: "/", omittingEmptySubsequences: true)
        guard components.count >= 2 else { return }
        let namespace = String(components[0])
        let destinationPath = components.dropFirst().joined(separator: "/")

        guard let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else { return }
        let identityURL = applicationSupport
            .appendingPathComponent("AutoMobile/staging-identities", isDirectory: true)
            .appendingPathComponent(namespace, isDirectory: true)
            .appendingPathComponent(destinationPath + ".json")
        guard let identityData = try? Data(contentsOf: identityURL),
              let identity = try? JSONDecoder().decode(StagingIdentity.self, from: identityData)
        else { return }

        let didAccess = selectedURL.startAccessingSecurityScopedResource()
        defer {
            if didAccess { selectedURL.stopAccessingSecurityScopedResource() }
        }
        guard let data = try? Data(contentsOf: selectedURL) else { return }
        let selectedHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard identity.schemaVersion == 1,
              identity.byteCount == data.count,
              identity.sha256 == selectedHash
        else { return }
        let marker = PickerVisibilityMarker(
            schemaVersion: 2,
            namespace: namespace,
            destinationPath: destinationPath,
            byteCount: data.count,
            sha256: selectedHash,
            generation: identity.generation
        )
        guard let encoded = try? JSONEncoder().encode(marker) else { return }
        let markerDirectory = applicationSupport.appendingPathComponent(
            "AutoMobile",
            isDirectory: true
        )
        try? fileManager.createDirectory(
            at: markerDirectory,
            withIntermediateDirectories: true
        )
        try? encoded.write(
            to: markerDirectory.appendingPathComponent("picker-visibility.json"),
            options: .atomic
        )
    }
}

private struct PickerVisibilityMarker: Codable {
    let schemaVersion: Int
    let namespace: String
    let destinationPath: String
    let byteCount: Int
    let sha256: String
    let generation: String
}

private struct StagingIdentity: Codable {
    let schemaVersion: Int
    let byteCount: Int
    let sha256: String
    let generation: String
}
