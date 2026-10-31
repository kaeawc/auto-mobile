import type {
  FixtureIdentity,
  FixtureIdentityProbe,
} from "../../src/features/snapshot/fixtureIdentity";

export class FakeFixtureIdentityProbe implements FixtureIdentityProbe {
  readonly queriedAvdNames: string[] = [];
  failWith: Error | undefined;

  constructor(public identity: FixtureIdentity) {}

  async currentIdentity(avdName: string): Promise<FixtureIdentity> {
    this.queriedAvdNames.push(avdName);
    if (this.failWith) {
      throw this.failWith;
    }
    return this.identity;
  }
}
