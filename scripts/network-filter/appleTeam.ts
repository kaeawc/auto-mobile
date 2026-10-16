/**
 * AutoMobile's Apple Developer Team ID. This is not a secret: it is embedded in
 * every signed artifact. It was read from the notarized screen-capture-helper
 * in release 0.0.83 (`codesign -dvv` reports `TeamIdentifier=CEZH89E7MT`,
 * "Developer ID Application: Jason Pearson (CEZH89E7MT)").
 *
 * The committed MDM profile for the network filter (#10595) pins this team.
 */
export const AUTOMOBILE_APPLE_TEAM_ID = "CEZH89E7MT";
