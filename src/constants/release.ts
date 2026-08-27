/**
 * Release constants - DO NOT EDIT MANUALLY
 *
 * This file contains release-specific constants that are updated automatically.
 * The values below are defaults for local development.
 *
 * The checksum registry is an ordered array of validated release checksums,
 * newest first (max 100 entries). "latest" resolves to registry[0].
 * Pinned versions (e.g. "0.0.18") do an exact lookup by version.
 *
 * During CI/CD release builds, new entries are prepended to the registry via
 * scripts/generate-release-constants.sh
 *
 * RELEASE_CHECKSUM_REGISTRY is append-only and records TAGGED releases only.
 * The nightly checksum job must never mutate a tagged entry: nightly builds
 * from `main` (ahead of the last tag), yet a tagged entry's download URL points
 * at immutable, already-published assets — overwriting its checksums in place
 * makes "latest" download the tagged asset but verify it against a main-built
 * sha, which cannot match (see PR #3784, where a nightly runner sha landed on
 * the tagged 0.0.44 entry and broke fresh-install integrity verification).
 * Nightly instead overwrites the dedicated, mutable NIGHTLY_CHECKSUM_ENTRY
 * below, which is deliberately kept OUT of RELEASE_CHECKSUM_REGISTRY so the
 * resolvers ("latest", pinned lookups, resolveLatestVersion) and the release
 * integrity gate — all of which key off the registry's first entry — never see
 * it.
 */

import { ActionableError } from "../models/ActionableError";

export const LATEST_RELEASE_VERSION = "latest";

/** Executable whose SHA-256 is recorded in a release entry. */
export type RunnerSha256Target = "runner" | "xctest";

export interface ReleaseChecksumEntry {
  version: string;
  apkSha256: string;
  ipaSha256: string;
  runnerSha256: string;
  /**
   * The executable represented by runnerSha256. Missing fields predate the
   * xctest migration and deliberately retain the legacy XCTRunner-stub target.
   */
  runnerSha256Target?: RunnerSha256Target;
  /**
   * SHA-256 of the persistent on-device H.264 encoder jar
   * (`automobile-video.jar`, #3776/#3830). Optional so registry entries that
   * predate the jar's release delivery tolerate an absent/empty value: an
   * absent checksum means the jar is unknown for that version and the client
   * degrades to `screenrecord` (see #3834). Populated by
   * scripts/generate-release-constants.sh (#3833) for releases that ship it.
   */
  videoJarSha256?: string;
  /**
   * SHA-256 of the signed, universal macOS ScreenCaptureKit helper archive.
   * Optional so releases predating the helper's GitHub-release delivery retain
   * their prior, explicit development-only fallback behavior.
   */
  screenCaptureHelperSha256?: string;
}

/**
 * Ordered checksum registry, newest first. Max 100 entries.
 * Each entry represents a validated release build.
 */
export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry[] = [
  {
    version: "0.0.66",
    apkSha256: "98f52fc04c429d14b1989a0adb219789e1f9590c799f04f865b10e4d0adbbfec",
    ipaSha256: "e6240589933833601be86dfda583fe85c8fa5ed2fe4516f5cc149cdf05a6796d",
    runnerSha256: "d072fb03ef1432b4a01760dd3d9f890458d86b1a4c118b26896f057a28075d1e",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "b6699df156c6cece51d1298c5ab14a6516bbe83645fda77b56fa750bf761e691",
  },
  {
    version: "0.0.65",
    apkSha256: "f5bde3760548fdd6cd67c58eb07b0494660ade08d7a15653e2006b73937e54ac",
    ipaSha256: "0c0134daa6c89e33ef98a7f2922e865b98ac26b317543228e8c1a52896496e9c",
    runnerSha256: "79a1f6fd5e7288ecbf3942c87357542c8dd0d481a60b211d9d65ea0051323e00",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "90b60c38c9f8353b77142631cb3e9dcfb730319e12bc88d6855c3e5a4bf715b9",
  },
  {
    version: "0.0.64",
    apkSha256: "bd824ecaa2ee8c3ce01dd4241925bb0c8ba680d3c1b75f6a0762cfe43e9f172f",
    ipaSha256: "3847654289a03a0cdccb755613ff8f88a5b61a53144b47800ddaea3c6631dfa8",
    runnerSha256: "d74d10b4f630729087e040969e37a2b4d16bf05ea478b64148c6250eb27aede8",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "6c5162b468a310c05a9b2877284996e73dac11c138fb485e3e2142971ee9241e",
  },
  {
    version: "0.0.63",
    apkSha256: "32c41a2ab7b6f1bb2f736f991de5010658ba5c7b1a1f5c990e390ed939454486",
    ipaSha256: "6f4a27c4d51b7cc8bf0b512fd163e0a1ff17cf4224c402c264788b23de78b622",
    runnerSha256: "e392dd7ff4d263c157b8958010447825eba53ef3aa73a54222a5a7090fb41db9",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "3a011807006e8c41ea5cb1ac2bb3e272950dc73f3dacd100e8a054411866d3d7",
  },
  {
    version: "0.0.62",
    apkSha256: "cb7e7f2d98de39a6db3764633190fadad0eff996f5145f1f744ca1be6d155120",
    ipaSha256: "3129f6969effaa8532890eb9fbfe2abd3d09a93c7dfbd0144d59b520125ec0c2",
    runnerSha256: "1620b28469c8df6faa8c51e9bea068c96199eed0d502c8f15aac065cabf709d3",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "e613b4c0b41755ccb82a5df79bc5590dd3209f795172974a53398f89a8abbcf4",
  },
  {
    version: "0.0.61",
    apkSha256: "78daf484347778d1c05c75616ba958532db72a6332c97faf4764d2980ba5ead0",
    ipaSha256: "24ab62d5c6743ec28f7cae06f81ffa6315d98fc35c00b826d53d300e69ca2269",
    runnerSha256: "fc178b53fd4362fdb70110ee374851dc986240e7498b7bc116136db63629119b",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "ea8ab5be598f6eac1ae04704a7fcd541b9ab741122da35d639294c2c8b2f4a4e",
  },
  {
    version: "0.0.60",
    apkSha256: "0ec30d1edf43f584df81341e59e96edfff3f8530979b4900fbf90ac54d2500ee",
    ipaSha256: "a5e8e081ea4c921b486dddac6437963c758de5bc409ed8745b336c737c9cf26c",
    runnerSha256: "492a6bb051614c04213136b41bf10cacb2b762e46a7d790f021a9e3d7f60414a",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "ec4971263a1da4055f86eea3ab4ba476a8dbce3120ed74fee7fd7e983713b3f3",
  },
  {
    version: "0.0.59",
    apkSha256: "da01b3a770638cb94c230fa2b208ee1d92b1a2bd0d9c70032482c8e4a0d9b39e",
    ipaSha256: "83aa5438aae053dc2cbd0fd360947c17e8a1a20b6262bf79d94a68d5d6b64d21",
    runnerSha256: "f2fe389faa321472a7f295b6078b2b09599f35c08535e0cb092c405b730d2f3d",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "490aa92e3e1ebe299c9558141f0aada5a468beb77d3ef70551b5e69cf5f7c076",
  },
  {
    version: "0.0.58",
    apkSha256: "fcace1ddf3bde22b780190f4fad5ecc4e8e85321881eece1203805d0578eb5ca",
    ipaSha256: "09e53b39283117782c0db99c57bf36163d91582c47989fd784e981b114069ad3",
    runnerSha256: "e4c016a662246c72455b0231714f26a9b283086ef571a7d912dc7c8ffff6a2ec",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "01f97581849f1cf3a0a258e4cd71434f7798b5dc11dab99ff760be757c765f6d",
  },
  {
    version: "0.0.57",
    apkSha256: "97595fe23177ce5c8e44b7a50a1061ea5804797764fee0062dd5553720e4894c",
    ipaSha256: "13c3b995c2ac6f32cbc9f7f56fe97335025d570a5b9a968aa14b5ccf8e1d129f",
    runnerSha256: "898af838e3c5e41576dc2cd98dd46d059fe690c7a3db27306bf6c4f62d493f17",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "bd230276077391a5e97a2034e950c03714f8798bab8c94f5ce7bdd56cd70b585",
  },
  {
    version: "0.0.56",
    apkSha256: "cf3d479a44637ec2b8c05888207b5e3a20fb7f67f0706ac65c2274beb61ab944",
    ipaSha256: "621c6cdeb6d9e88b04072f9daf7f955051129be16fddd1c3828620a47e4aaa37",
    runnerSha256: "31094d3e12b1678252bbc27170e3d2a4c38818cea6b3c10e6cfbadf1e6051761",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "41c42eb5896e09f33ca2d09ef712217ef59cbd5f7b4abc2df812e77fc463bed5",
  },
  {
    version: "0.0.55",
    apkSha256: "c12f8f5d47a252c3128d5f71bcae56fb586c6c34c573fc6d5f7a2d19e108c6c8",
    ipaSha256: "73560b76e2dcb707ff0a0724214deb77bdceedebfbffb7ebd02d5942a48661da",
    runnerSha256: "c56afd1de9fa4fc8bee260b8c73b8da61eefd931e42330c906982fb8796ac00f",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "7d97186fca4d74a223a027a563e96d7879248f17979ead5bdf68c927522a9c3b",
  },
  {
    version: "0.0.54",
    apkSha256: "75289f35aa378d5bf335c9f4479f94012ebd3c20987ea47cb8ab961de38712d2",
    ipaSha256: "2810e3752c7fe1d3bf018f4ed34679a8b9aca6d696e0f4699b1ba74d8e5c2c38",
    runnerSha256: "4a0541207649738137b1c9f249496bbb8f22e8fcea09a0bea22f419716a6123f",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "2e2f4ede42ebc510fb9997c36e0838ee67e09ca93e18d7dedf68a91635413753",
  },
  {
    version: "0.0.53",
    apkSha256: "90abd8d18acb664e4bca01f0ff3c6b62356bf38c422850c5e81cea02a99aba83",
    ipaSha256: "f59df4678c2d92b9c0572599e4babdffa3125343cf49f74a47b97635131ae003",
    runnerSha256: "be40cd445514b83a9d5fae54cbd1688fc5f20292d2f70f8016a473644d371b72",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "038046ef2f043729f9cf38f1bdc7d7bbe6070a919759105a5470df2c0fb14fb3",
  },
  {
    version: "0.0.52",
    apkSha256: "b733c267e42d4af3b24ba15ae7c94393cdf775018c3167deb13d06f33c6d5124",
    ipaSha256: "f8c9d00607dfc9c25bd7ee3de785f5a0f7e516ee90c6a7209ae5af9129063be5",
    runnerSha256: "7573432ea9c86c29acec30662ad7512cdb299150bc607350c7e3361882577f1c",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "f15e2bc4f4b2fece0daa85cb3fa3acbfcd08318cc420fc0637b469cd078d34b8",
  },
  {
    version: "0.0.51",
    apkSha256: "e9da610303113dd13094b3f885090b846f5b8705ac203b09deeb267801049255",
    ipaSha256: "db5606723087f7b973893d4adefcdeb6aadf1da0e2bcc435ce1fe8787bafb712",
    runnerSha256: "abba47298118068aaad3b8ea4502d685263b6e83cd2c30bb0518840cb8443202",
    runnerSha256Target: "xctest",
    videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
    screenCaptureHelperSha256: "a46ec61cdd2c3ab64e0f621f3498726578e52bee407d16cd90cde32ca8164798",
  },
  {
    version: "0.0.50",
    apkSha256: "8007f267d566144d805d29d22fb0e69790d34edcdbdd0d444bad6d80175943e2",
    ipaSha256: "838025a37b8a9f0d15b0b1ad06ff40e5a2b0b3e09eeca845f9a874d3bac4030d",
    runnerSha256: "5e53b1614986f90b875e5ada0a8c97f5343c22e70bdaeafd9a8389e5b6ef78ae",
    runnerSha256Target: "xctest",
    videoJarSha256: "254d1bad102a96b1e8e90ee9ff6ff991aa6d65f7a36a35c3887db91f369ea12e",
    screenCaptureHelperSha256: "965a49653d0c8bc8a88d45e1919ef0a62267d6774c50579411076dbe397bb89d",
  },
  {
    version: "0.0.49",
    apkSha256: "c1023110ebbd12c012880b08be6715d2389294fd24c4a147a40d1d342ec473da",
    ipaSha256: "dbeacd346a39976414432964de1250a3f356baf783cd3a83d916f0117e772d5b",
    runnerSha256: "fc033a529c67d373c6eca965ec063343b6164628d62e14eca220385810427ae6",
    runnerSha256Target: "xctest",
    videoJarSha256: "254d1bad102a96b1e8e90ee9ff6ff991aa6d65f7a36a35c3887db91f369ea12e",
    screenCaptureHelperSha256: "67079809a52e3cad50a38f04e4e25d795c0756b35352b377ba9609bebb62ab0f",
  },
  {
    version: "0.0.48",
    apkSha256: "059162e622fbe25bce40b32658c9749318a909eb8b48398648c77a84cf3c25aa",
    ipaSha256: "86558163f69a0bf36e69546dbf685d16d8f3bf05385f1f7795a164e3a5fddf96",
    runnerSha256: "ff000ff053a57a1dac1d552463e474fdea5346acb08c96051695554e73428317",
    runnerSha256Target: "xctest",
    videoJarSha256: "1cada2f3bc86cacbed76efc8e46c1e110cb0b046036502b422d67cce0725cf4b",
    screenCaptureHelperSha256: "f284e9863cedb2e02de25f526114fd4017eece1ce1e19337210647c7b49d1898",
  },
  {
    version: "0.0.47",
    apkSha256: "aa50a056447337ca14c251795b064e792879a28d088fe484fe57893a020b9323",
    ipaSha256: "ef5d10dd97d78d8e372680fffbb511335781b03ffbf0c91e2692048da4c5f143",
    runnerSha256: "078375d34d3e8bfa0c3171e3f1a6558d0ca2c0ca1f0c5999cb49077934fbfc0a",
    runnerSha256Target: "xctest",
    videoJarSha256: "5e3760d04436af89ec909586bd244d79cd7acec9b84993f4302fa7bf480916cb",
    screenCaptureHelperSha256: "501e1253ded9fa2f331051b88013b47ca37343a1966fc106d4fcaa5e9bbe4c39",
  },
  {
    version: "0.0.46",
    apkSha256: "00771c13f372baff325c659e2b40050e72951fd8adfc395cff667850a2a9b376",
    ipaSha256: "ef353a4f14fa7615810de891595d118ff193d43fcc940f936f4d11ae311dd563",
    screenCaptureHelperSha256: "da7e138266156eedda9f8cb98bb7d5b63f29ad28746a1c144a16122a1639e2b2",
    runnerSha256: "b0eb970aad424d1c0dd84261c26d74b8c95570ba0f3866f18f1755586184c51a",
    runnerSha256Target: "xctest",
    videoJarSha256: "3f3135e22fffed1e088bd434545eec873a5aec48c7c038cd2ffecdeb6b642c06",
  },
  {
    version: "0.0.45",
    apkSha256: "68dbf04ba3c1871da0ed9ec540e1dbfec08610dd2afc1706d4a7fd94d1c3b5b1",
    ipaSha256: "8c678b2d7ae4b5c25400f8fd53cb5e1f12d730950e0eef4e608dfb8b50dcd773",
    runnerSha256: "bb5234ca32636506e5b8e02662381895eaedeefbcf007598e3ee9b9ac3c501b5",
    runnerSha256Target: "xctest",
    videoJarSha256: "bae314fbaa3f3101ab5f7ba5eddc9bd77bb927c54cb508d38ed04ca9544b9a51",
  },
  {
    version: "0.0.44",
    apkSha256: "e95f2b14e218bc51e92a44680cf38ceca9c9143014b2f74b803f47650614cf39",
    ipaSha256: "73dd4551ef7226d67a46423f6925775fc10d68198913b5b23bc1cbdceb50b663",
    runnerSha256: "b281f9fd516116164a76dc049a413d5123bfb7bf96c79c6ad654ba90c08ed982",
  },
  {
    version: "0.0.43",
    apkSha256: "7e4e2ce3c19b7473d171433186dbc7487df60ff6045dba66da7a320d31e63cd3",
    ipaSha256: "db0e3c4c172681068ae7ae24182f5569519b5fab034fbcf0e85abdc952b398dd",
    runnerSha256: "b281f9fd516116164a76dc049a413d5123bfb7bf96c79c6ad654ba90c08ed982",
  },
  {
    version: "0.0.42",
    apkSha256: "cb00a835f58ce2d0344483f27b7c35036bb6faa973aa3fcc66fe67e75428abb0",
    ipaSha256: "de55b77ee0e821b4f08b7cd1b84f9a2706f69279422901546e2dc6fdd4cc3f0f",
    runnerSha256: "b281f9fd516116164a76dc049a413d5123bfb7bf96c79c6ad654ba90c08ed982",
  },
  {
    version: "0.0.41",
    apkSha256: "ee1dff240e4dfc89b016197c80e929797485aa23292e061eee361b7404c772b4",
    ipaSha256: "01eaedef0cfcf38acd0a1fa8eebe08c3009e5db59320b23a045cd26506eb235c",
    runnerSha256: "b281f9fd516116164a76dc049a413d5123bfb7bf96c79c6ad654ba90c08ed982",
  },
  {
    version: "0.0.40",
    apkSha256: "8e89fbab6462ac1ead1f3f0a334aff4f5f299e7ae72e192045cf75e893ca87aa",
    ipaSha256: "38adaed641ac6a8590773682e127a80a86c54e5804d47394e1b0cd437009b9ff",
    runnerSha256: "b281f9fd516116164a76dc049a413d5123bfb7bf96c79c6ad654ba90c08ed982",
  },
  {
    version: "0.0.39",
    apkSha256: "eaad59dd85e17c4633098b772b9f761f2124ffb73a5ca7ede703a9b435046942",
    ipaSha256: "87a720544c83718e5b70c987aecf30d2e43bdb0f23163ac75ac225bb4aec0ae4",
    runnerSha256: "",
  },
  {
    version: "0.0.38",
    apkSha256: "0fb955a617654695036642662634d042c2e3d278b8e1dce20ccb37e425f059f3",
    ipaSha256: "f5a4a485ff8ebf3bfd0d73c8b7b10769177b419ccd62e48db188bb5122a2fcde",
    runnerSha256: "",
  },
  {
    version: "0.0.37",
    apkSha256: "f9b0cc92bf8f7416cdb0c458e16c7a41e4fdeefb80bb9429ab7c603388c99083",
    ipaSha256: "caccbfaa4da0015bab701a36b81ac87e3f3f3330cee77bb10ec8553724275f4f",
    runnerSha256: "",
  },
  {
    version: "0.0.36",
    apkSha256: "b5f56bb0ab065c60385a22013c97ee706213eb16deb5d4bcfa42f0a707b8620a",
    ipaSha256: "40e973dc8c87149e40a616658c74d90e648c6514cc642a5c3dd4a45a187e7600",
    runnerSha256: "",
  },
  {
    version: "0.0.35",
    apkSha256: "039b359bcf35f1ab6cc666005a57823d71a771a96bd9bcaf4f82f2ec945e306d",
    ipaSha256: "e6afdfd04a90d2388dc4604e7957d3eef87b90a51ca37c5457b8139a54728108",
    runnerSha256: "",
  },
  {
    version: "0.0.34",
    apkSha256: "4dcee4f6a7359847d081c5e184c57ed100ad135af2e62f3abfc7b0defaa1153c",
    ipaSha256: "c2a26ca065c85e9f8d5cfcd6dbad1dbaf3ce38b18d770b0983f7bad62129e4a3",
    runnerSha256: "",
  },
  {
    version: "0.0.33",
    apkSha256: "7289eba90b22890d3c36e05e99db72a545fa4becdf46df079885783a919e6aed",
    ipaSha256: "425dfa4db4ad5a4febc9f05ffc97df38f3a1098ccdd9330adff1c0b5c877697d",
    runnerSha256: "",
  },
  {
    version: "0.0.32",
    apkSha256: "4c4a743af5d18ed58214e64b85986c9e2f2332b015edcf7d9d68a24cd6dfda21",
    ipaSha256: "40f4d9084d3368995b57c0e81c4fe85f38851353da9f789eaff93027aee456a0",
    runnerSha256: "",
  },
  {
    version: "0.0.31",
    apkSha256: "0b5802ada8d9adccdb69ee140ae788b3251832c0605d2f6baa3e9b7a78260764",
    ipaSha256: "e60f8689fb6ddd5c06a5d2ff57569b264f407229afb986258d1ce20326dc24c7",
    runnerSha256: "",
  },
  {
    version: "0.0.30",
    apkSha256: "a1be5e6240f204ee99540e99cc198f7c0b592dbaf3699330c14f6ded7d333ec3",
    ipaSha256: "5ac285dd5be16439d3a8a8973c98606920461acfce489830e54ee20759a7b235",
    runnerSha256: "",
  },
  {
    version: "0.0.29",
    apkSha256: "b33a67c7efa84aca2b07faa965aecb3b1819b4defd441dcc8d3bf7e2af209cd8",
    ipaSha256: "d47c1aea4495270c1489cae361286ea1439c2ba4e7d5bcfd73f66e4580a6c45d",
    runnerSha256: "",
  },
  {
    version: "0.0.28",
    apkSha256: "0f683d5939bc308afe038ea1259eb29997dff38af0795136a281ad305986e40e",
    ipaSha256: "eee7accfbca717bb8b89fafd0676f10d8bb08561c3fbd7a04750c9b12c2a7104",
    runnerSha256: "",
  },
  {
    version: "0.0.27",
    apkSha256: "9966113ae44f38f3cf34544b1375d3c9a3706701edba45a1eec1f220b9c676cc",
    ipaSha256: "8620de6b014df18465876334f9ba8c106292f6c3059370eea2349f1e44db4f4d",
    runnerSha256: "",
  },
  {
    version: "0.0.26",
    apkSha256: "2eb2f156fd27602c85003ab8f6e00d3e06850e84f5453d75b7494aa5bbed7be0",
    ipaSha256: "905df276d2224d31cbc5aa2258d2dcc60eaeb9813727081ddd32c95394fec411",
    runnerSha256: "",
  },
  {
    version: "0.0.25",
    apkSha256: "f727079edb4906e3b7928dbb641e788543e86b11fff3fc1b76f0c51b9c8d6e5d",
    ipaSha256: "d8032cc1cebcb456b7232aa67fc42c89ff62729bacf141aa8f594ce6f8bcd980",
    runnerSha256: "",
  },
  {
    version: "0.0.24",
    apkSha256: "9047795bc6098f4ec687c126123c73c423806a9fd52888af391d6fb5b94ac93f",
    ipaSha256: "1dd3e0370cb8ed01d8e1020558d8a2808f208bd947bafcf6688211eddc928bf8",
    runnerSha256: "",
  },
  {
    version: "0.0.18",
    apkSha256: "fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834",
    ipaSha256: "2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39",
    runnerSha256: "",
  },
  {
    version: "0.0.17",
    apkSha256: "916033440931666644474f227c8e39d13d9c80c3515e4292cc5581fd5bd4cc2f",
    ipaSha256: "e4dcf064d024f2371b8fd79281000e2d49751ef95b8817d1494d685aeda746ac",
    runnerSha256: "",
  },
];

/**
 * Dedicated, mutable "nightly" checksum slot — the current state of `main`.
 *
 * This is the ONLY entry the nightly checksum job overwrites in place. It is
 * intentionally NOT part of RELEASE_CHECKSUM_REGISTRY: keeping it separate is
 * what makes it structurally impossible for nightly to corrupt a tagged release
 * entry (the #3784 failure mode). Because no resolver consults it, pinning
 * `AUTOMOBILE_VERSION=nightly` is treated as an unknown version and fails closed
 * — there is no published, downloadable nightly asset to verify against. This
 * slot exists purely as a drift record: the nightly workflow compares a fresh
 * `main` build against these values and opens a PR when they diverge.
 *
 * The `version: "nightly"` sentinel is how scripts/generate-release-constants.sh
 * (checksum-only mode) and .github/workflows/nightly.yml target this entry
 * without touching registry[0].
 */
export const NIGHTLY_CHECKSUM_ENTRY: ReleaseChecksumEntry = {
  version: "nightly",
  apkSha256: "31c4cf22371e50fb4121723b38a207fc261aec56b68d7b9867001e47ae31eafa",
  ipaSha256: "25097052c69d9c4475346612181539af1c58f7676d01ff2c738b32bcaa4964b9",
  runnerSha256Target: "xctest",
  videoJarSha256: "e5ce791aed17a1bf391db5737367a8ca2d7792b805f2fa4235e4ec7f8cee062c",
  runnerSha256: "967c25c23b847b539939a00e3acac870c566fec5694464bef80fa4e8e3beffdb",
};

/**
 * Resolve a checksum from the registry.
 * - "latest" → registry[0] (most recent validated build)
 * - pinned version (e.g. "0.0.18") → exact match lookup
 * - unknown version or empty registry → ""
 */
export function resolveChecksum(
  version: string,
  platform: "android" | "ios",
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  if (registry.length === 0) {
    return "";
  }
  const normalized = version.trim().toLowerCase();
  const entry =
    normalized === LATEST_RELEASE_VERSION
      ? registry[0]
      : registry.find((e) => e.version === version);
  if (!entry) {
    return "";
  }
  return platform === "android" ? entry.apkSha256 : entry.ipaSha256;
}

/**
 * The registry entry for the pinned version (`AUTOMOBILE_VERSION`), or the
 * latest validated build when unpinned. Returns `undefined` when the registry
 * is empty or the pin is unknown. Shared entry-selection for the per-field
 * `resolve*Checksum` resolvers below, which differ only in which field they read
 * and their default. (`resolveChecksum` above takes an explicit version +
 * platform and normalizes case, so it stays separate.)
 */
function entryForPinnedVersion(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): ReleaseChecksumEntry | undefined {
  if (registry.length === 0) {
    return undefined;
  }
  const pinned = resolvePinnedVersion(env);
  return pinned === LATEST_RELEASE_VERSION
    ? registry[0]
    : registry.find((e) => e.version === pinned);
}

export function resolveRunnerChecksum(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  return entryForPinnedVersion(env, registry)?.runnerSha256 ?? "";
}

/**
 * Resolve the executable represented by the selected runner checksum.
 * Existing entries omit this field because their hashes were taken from the
 * outer XCTRunner stub before CtrlProxy's code executable was adopted.
 */
export function resolveRunnerChecksumTarget(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): RunnerSha256Target {
  return entryForPinnedVersion(env, registry)?.runnerSha256Target ?? "runner";
}

/**
 * Version of the latest validated release in the registry.
 * Used to construct download URLs for pinned releases.
 */
export function resolveLatestVersion(
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  if (registry.length === 0) {
    return LATEST_RELEASE_VERSION;
  }
  return registry[0].version;
}

// --- Backward-compatible exports derived from RELEASE_VERSION ---

export const RELEASE_VERSION: string = LATEST_RELEASE_VERSION;

/**
 * Resolve a version string to its concrete equivalent. Module-level constants
 * (URLs, on-disk metadata, doctor checks) want a concrete version like
 * "0.0.30", never the placeholder "latest".
 */
export function resolveAssetVersion(
  version: string,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  if (version === LATEST_RELEASE_VERSION) {
    return resolveLatestVersion(registry);
  }
  return version;
}

// --- Hermetic single-version pinning knobs (issue #2746) ---
//
// External CI consumers need one coherent way to pin every AutoMobile component
// to a single version and, optionally, to mirror the release assets off GitHub.
// These pure, env-injectable resolvers are the daemon-side source of truth that
// the Android/iOS clients delegate to (via `ide/status` + the CtrlProxy managers).

/** npm package name of the daemon. */
export const DAEMON_PACKAGE_NAME = "@kaeawc/auto-mobile";

/** Environment variable that pins daemon + APK + IPA to one coherent version. */
export const AUTOMOBILE_VERSION_ENV = "AUTOMOBILE_VERSION";

/** Environment variable that mirrors the APK/IPA download host for offline CI. */
export const AUTOMOBILE_ASSET_BASE_URL_ENV = "AUTOMOBILE_ASSET_BASE_URL";

/**
 * Opt-out that permits a plaintext `http://` asset base/bundle URL (issue #4761).
 * DEFAULT = require `https:`; asset downloads over cleartext are a
 * confidentiality/downgrade risk (a network attacker can observe the fetch and,
 * combined with a redirect, weaken the delivery path even though the pinned
 * checksum still blocks substitution). Set to `1`/`true` ONLY for a trusted
 * loopback/dev mirror (e.g. `http://127.0.0.1:8080` or `http://localhost`).
 */
export const AUTOMOBILE_ALLOW_INSECURE_ASSET_URL_ENV = "AUTOMOBILE_ALLOW_INSECURE_ASSET_URL";

/** Default GitHub Releases base for versioned asset downloads. */
export const DEFAULT_ASSET_BASE_URL = "https://github.com/kaeawc/auto-mobile/releases/download";

type EnvLike = Record<string, string | undefined>;

/** True when the plaintext-http opt-out ({@link AUTOMOBILE_ALLOW_INSECURE_ASSET_URL_ENV}) is set. */
function isInsecureAssetUrlAllowed(env: EnvLike): boolean {
  const value = env[AUTOMOBILE_ALLOW_INSECURE_ASSET_URL_ENV];
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * Enforce `https:` on an asset download URL (issue #4761). Rejects `http://` and
 * any other non-TLS scheme unless {@link AUTOMOBILE_ALLOW_INSECURE_ASSET_URL_ENV}
 * opts into plaintext for a trusted loopback/dev mirror. Throws
 * {@link ActionableError} — used both for the `AUTOMOBILE_ASSET_BASE_URL` mirror
 * and the iOS bundle-URL override.
 *
 * @param label the env var / knob name to name in the error message.
 */
export function assertHttpsAssetUrl(url: string, label: string, env: EnvLike = process.env): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ActionableError(
      `${label} must be an absolute URL, for example https://mirror.example/auto-mobile.`,
    );
  }
  if (parsed.protocol === "https:") {
    return;
  }
  if (isInsecureAssetUrlAllowed(env)) {
    return;
  }
  throw new ActionableError(
    `${label} must use https:// (got ${parsed.protocol}//). Plaintext/non-TLS asset downloads are a ` +
      `confidentiality and downgrade risk. Set ${AUTOMOBILE_ALLOW_INSECURE_ASSET_URL_ENV}=1 to opt out ` +
      `for a trusted loopback/dev mirror.`,
  );
}

/**
 * Resolve the pinned version from `AUTOMOBILE_VERSION`. Returns the trimmed value
 * when set, otherwise the `"latest"` placeholder (which downstream resolvers turn
 * into the concrete newest registry entry). The `latest` sentinel is normalized to
 * lower-case so every sink agrees — `resolveChecksum` matches `latest`
 * case-insensitively but `resolveAssetVersion`/URL building use a strict `===`
 * compare, so an un-normalized `LATEST` would otherwise resolve to a valid checksum
 * yet a 404 URL (an incoherent triple).
 */
export function resolvePinnedVersion(env: EnvLike = process.env): string {
  const trimmed = env[AUTOMOBILE_VERSION_ENV]?.trim();
  if (!trimmed || trimmed.length === 0) {
    return LATEST_RELEASE_VERSION;
  }
  return trimmed.toLowerCase() === LATEST_RELEASE_VERSION ? LATEST_RELEASE_VERSION : trimmed;
}

/**
 * True when `AUTOMOBILE_VERSION` names a concrete version (not unset, not the
 * `latest` sentinel). Used to decide whether an unverifiable download should
 * fail closed.
 */
export function isExplicitPin(env: EnvLike = process.env): boolean {
  return resolvePinnedVersion(env) !== LATEST_RELEASE_VERSION;
}

/**
 * True when the effective pin resolves to a checksum-bearing registry entry.
 * A `latest` pin is known iff the registry is non-empty; a concrete pin is known
 * iff the registry contains it. A pinned-but-unknown version cannot be
 * integrity-verified — see the fail-closed guards in the CtrlProxy managers.
 */
export function isPinnedVersionKnown(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): boolean {
  const pinned = resolvePinnedVersion(env);
  if (pinned === LATEST_RELEASE_VERSION) {
    return registry.length > 0;
  }
  return registry.some((entry) => entry.version === pinned);
}

/**
 * Resolve the asset download base URL. Returns `AUTOMOBILE_ASSET_BASE_URL`
 * (trimmed, trailing slashes stripped) when set, otherwise the GitHub default.
 */
export function resolveAssetBaseUrl(env: EnvLike = process.env): string {
  const trimmed = env[AUTOMOBILE_ASSET_BASE_URL_ENV]?.trim();
  if (trimmed && trimmed.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new ActionableError(
        `${AUTOMOBILE_ASSET_BASE_URL_ENV} must be an absolute URL, for example https://mirror.example/auto-mobile.`,
      );
    }
    if (trimmed.includes("?") || trimmed.includes("#")) {
      throw new ActionableError(
        `${AUTOMOBILE_ASSET_BASE_URL_ENV} must not include a query string or fragment; ` +
          `use a path-only base URL such as ${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}.`,
      );
    }
    // Require https:// unless the plaintext opt-out is set (issue #4761).
    assertHttpsAssetUrl(`${parsed.origin}${parsed.pathname}`, AUTOMOBILE_ASSET_BASE_URL_ENV, env);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  }
  return DEFAULT_ASSET_BASE_URL;
}

function buildReleaseAssetUrl(
  filename: string,
  version: string,
  baseUrl: string = DEFAULT_ASSET_BASE_URL,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  const assetVersion = resolveAssetVersion(version, registry);
  if (assetVersion === LATEST_RELEASE_VERSION) {
    // Degenerate case: empty registry, no concrete version to key off.
    if (baseUrl === DEFAULT_ASSET_BASE_URL) {
      // Fall back to GitHub's redirecting /latest/download/ endpoint.
      return `https://github.com/kaeawc/auto-mobile/releases/latest/download/${filename}`;
    }
    // A mirror has no redirecting endpoint; use a conventional /latest/ path.
    return `${baseUrl}/latest/${filename}`;
  }
  return `${baseUrl}/${assetVersion}/${filename}`;
}

/** APK download URL honoring `AUTOMOBILE_VERSION` + `AUTOMOBILE_ASSET_BASE_URL`. */
export function resolveApkUrl(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  return buildReleaseAssetUrl(
    "control-proxy-debug.apk",
    resolvePinnedVersion(env),
    resolveAssetBaseUrl(env),
    registry,
  );
}

/** iOS IPA download URL honoring `AUTOMOBILE_VERSION` + `AUTOMOBILE_ASSET_BASE_URL`. */
export function resolveIpaUrl(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  return buildReleaseAssetUrl(
    "control-proxy.ipa",
    resolvePinnedVersion(env),
    resolveAssetBaseUrl(env),
    registry,
  );
}

/** Expected APK SHA-256 for the pinned version (empty string if unknown). */
export function resolveApkChecksum(env: EnvLike = process.env): string {
  return resolveChecksum(resolvePinnedVersion(env), "android");
}

/** Expected iOS IPA SHA-256 for the pinned version (empty string if unknown). */
export function resolveIpaChecksum(env: EnvLike = process.env): string {
  return resolveChecksum(resolvePinnedVersion(env), "ios");
}

/**
 * Fixed asset filename of the persistent on-device H.264 encoder jar.
 * The same name is used as the CI artifact, the release asset, and the
 * client-side cached file (#3830–#3835).
 */
export const VIDEO_SERVER_JAR_FILENAME = "automobile-video.jar";

/** Fixed GitHub Release asset for the signed universal macOS capture helper. */
export const SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME = "screen-capture-helper-macos-universal.zip";

/**
 * video-server jar download URL honoring `AUTOMOBILE_VERSION` +
 * `AUTOMOBILE_ASSET_BASE_URL`, mirroring `resolveApkUrl`/`resolveIpaUrl`.
 */
export function resolveVideoJarUrl(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  return buildReleaseAssetUrl(
    VIDEO_SERVER_JAR_FILENAME,
    resolvePinnedVersion(env),
    resolveAssetBaseUrl(env),
    registry,
  );
}

/**
 * Expected video-server jar SHA-256 for the pinned version. Returns an empty
 * string when unknown — either the pin is absent from the registry, or the
 * matched entry predates jar delivery (no `videoJarSha256`). Callers treat an
 * empty checksum as "unknown → degrade to screenrecord" (#3834).
 */
export function resolveVideoJarChecksum(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  return entryForPinnedVersion(env, registry)?.videoJarSha256 ?? "";
}

/** Download URL for the signed macOS ScreenCaptureKit helper archive. */
export function resolveScreenCaptureHelperUrl(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  return buildReleaseAssetUrl(
    SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME,
    resolvePinnedVersion(env),
    resolveAssetBaseUrl(env),
    registry,
  );
}

/** Expected archive SHA-256 for the selected screen-capture-helper release. */
export function resolveScreenCaptureHelperChecksum(
  env: EnvLike = process.env,
  registry: ReleaseChecksumEntry[] = RELEASE_CHECKSUM_REGISTRY,
): string {
  return entryForPinnedVersion(env, registry)?.screenCaptureHelperSha256 ?? "";
}

/**
 * Concrete `@kaeawc/auto-mobile@<version>` install specifier for user-facing
 * advice. Never yields the floating `@latest` tag (which causes silent version
 * drift between a human-started daemon and a pinned runner, #2746) — it resolves
 * `AUTOMOBILE_VERSION`, falling back to the concrete newest registry entry.
 */
export function resolveDaemonInstallSpecifier(env: EnvLike = process.env): string {
  return `${DAEMON_PACKAGE_NAME}@${resolveAssetVersion(resolvePinnedVersion(env))}`;
}

export const APK_URL: string = resolveApkUrl({});
export const APK_SHA256_CHECKSUM: string = resolveApkChecksum({});

export const IOS_CTRL_PROXY_RELEASE_VERSION: string = RELEASE_VERSION;
export const IOS_CTRL_PROXY_IPA_URL: string = resolveIpaUrl({});
export const IOS_CTRL_PROXY_SHA256_CHECKSUM: string = resolveIpaChecksum({});
export const IOS_CTRL_PROXY_APP_HASH: string = ""; // Hash of CtrlProxyApp.app (device build), empty = skip verification
// SHA256 of the simulator runner executable, empty = skip verification. The
// per-release target records whether that is the legacy XCTRunner stub or the
// CtrlProxy xctest executable.
export const IOS_CTRL_PROXY_RUNNER_SHA256_CHECKSUM: string = resolveRunnerChecksum({});
