import type {
  MagiskStubApk,
  MagiskStubBuilder,
} from "../../src/features/deviceCondition/magiskStub";

export class FakeStubBuilder implements MagiskStubBuilder {
  builds = 0;
  disposed = 0;

  async build(): Promise<MagiskStubApk> {
    this.builds++;
    return {
      path: "/fake/magisk.apk",
      dispose: async () => {
        this.disposed++;
      },
    };
  }
}
