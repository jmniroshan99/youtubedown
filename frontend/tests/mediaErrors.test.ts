import { describe, expect, it } from "vitest";
import { mediaFailureMessage, mediaFailureReference } from "../src/mediaErrors";

describe("source failure messages", () => {
  it("keeps unknown diagnostics and prototype keys out of user-visible messages", () => {
    for (const code of ["private diagnostic https://example.test/?token=fixture", "toString", "__proto__", "EXTRACTION_FAILED"]) {
      const message = mediaFailureMessage(code);
      expect(message).toContain("could not be analyzed");
      expect(message).not.toContain(code);
    }
  });
  it("explains source limitations without suggesting app login unlocks them", () => {
    expect(mediaFailureMessage("LOGIN_REQUIRED")).toContain("source requires its own account");
    expect(mediaFailureMessage("REGION_RESTRICTED")).toContain("this server cannot retrieve");
    expect(mediaFailureMessage("DRM_UNSUPPORTED")).toContain("cannot be downloaded here");
  });
  it("provides safe stage references without arbitrary provider diagnostics", () => {
    expect(mediaFailureReference("SOURCE_BLOCKED", "analysis")).toBe("Reference: SOURCE_BLOCKED · Stage: analysis");
    expect(mediaFailureReference("https://private/?token=secret", "secret stage")).toBe("Reference: EXTRACTION_FAILED · Stage: download");
    expect(mediaFailureMessage("SERVICE_UNAVAILABLE")).toContain("backend");
    expect(mediaFailureMessage("PAYWALL_RESTRICTED")).toContain("subscription");
  });
  it("distinguishes source certificate failures from ordinary connectivity failures", () => {
    expect(mediaFailureMessage("SOURCE_TLS_ERROR")).toContain("HTTPS certificate");
    expect(mediaFailureMessage("SOURCE_TLS_ERROR")).toContain("administrator");
    expect(mediaFailureReference("SOURCE_TLS_ERROR", "analysis")).toBe("Reference: SOURCE_TLS_ERROR · Stage: analysis");
  });
});
