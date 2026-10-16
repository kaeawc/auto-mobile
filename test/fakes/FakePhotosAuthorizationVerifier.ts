import type {
  PhotosAuthorizationStatus,
  PhotosAuthorizationVerifier,
} from "../../src/features/action/IosSimulatorPermissions";

export class FakePhotosAuthorizationVerifier implements PhotosAuthorizationVerifier {
  readonly calls: Array<{ deviceId: string; appId: string }> = [];

  constructor(
    public status: PhotosAuthorizationStatus = "unobservable",
    public error?: Error,
  ) {}

  async verifyReadWrite(deviceId: string, appId: string): Promise<PhotosAuthorizationStatus> {
    this.calls.push({ deviceId, appId });
    if (this.error) {
      throw this.error;
    }
    return this.status;
  }
}
