import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A simulator smoke-test probe for #5806, not a production file provider.
///
/// The host script places a fixture only in `Documents/automobile-issue-5806`.
/// With this app's File Sharing and open-in-place keys enabled, iOS's local File
/// Provider exposes that directory to the real `UIDocumentPickerViewController`.
struct FilesPickerProbeView: View {
    @State private var selectedFixture = "No fixture selected"
    @State private var showingPicker = false

    var body: some View {
        VStack(spacing: 16) {
            Text("Files picker probe")
                .font(.title2)
            Text("The #5806 smoke stages fixtures only in this app's bounded Documents namespace.")
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
            FilesPickerController(selectedFixture: $selectedFixture)
        }
        .trackNavigation(destination: "files_picker_probe")
    }
}

private struct FilesPickerController: UIViewControllerRepresentable {
    @Binding var selectedFixture: String

    func makeUIViewController(context: Context) -> FilesPickerHostViewController {
        FilesPickerHostViewController { selectedFixture = $0 }
    }

    func updateUIViewController(_ uiViewController: FilesPickerHostViewController, context: Context) {}
}

private final class FilesPickerHostViewController: UIViewController, UIDocumentPickerDelegate {
    private static let fixtureNamespace = "automobile-issue-5806"
    private let didSelectFixture: (String) -> Void
    private var didPresentPicker = false

    init(didSelectFixture: @escaping (String) -> Void) {
        self.didSelectFixture = didSelectFixture
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !didPresentPicker else { return }
        didPresentPicker = true

        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.plainText, .pdf])
        picker.delegate = self
        picker.directoryURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent(Self.fixtureNamespace, isDirectory: true)
        present(picker, animated: false)
    }

    func documentPicker(
        _ controller: UIDocumentPickerViewController,
        didPickDocumentsAt urls: [URL]
    ) {
        didSelectFixture(urls.first?.lastPathComponent ?? "No fixture selected")
        dismiss(animated: true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        dismiss(animated: true)
    }
}
