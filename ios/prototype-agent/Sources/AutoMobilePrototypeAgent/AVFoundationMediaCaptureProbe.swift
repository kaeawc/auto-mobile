#if os(iOS)
    import AVFoundation

    /// Reads capture hardware without opening a session, so it never triggers a permission prompt.
    @MainActor
    struct AVFoundationMediaCaptureProbe: PrototypeMediaCaptureProbe {
        var isSimulator: Bool {
            #if targetEnvironment(simulator)
                true
            #else
                false
            #endif
        }

        var videoCaptureDeviceCount: Int {
            AVCaptureDevice.DiscoverySession(
                deviceTypes: [.builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera],
                mediaType: .video,
                position: .unspecified
            ).devices.count
        }

        var audioInputAvailable: Bool { AVAudioSession.sharedInstance().isInputAvailable }
    }
#endif
