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

  it.each([
    [900, "15 minutes"],
    [3600, "1 hour"],
    [901, "15 minutes 1 second"],
  ])("shows the server duration limit of %i seconds", (max_duration, readable) => {
    for (const stage of ["analysis", "download"] as const) {
      const message = mediaFailureMessage("DURATION_LIMIT", stage, { max_duration });
      expect(message).toContain(`current limit of ${readable}`);
      expect(message).toContain("Choose a shorter video.");
    }
  });

  it("keeps the original guidance when the duration limit is missing or invalid", () => {
    const invalidLimits: unknown[] = [
      undefined, null, {}, { max_duration: undefined }, { max_duration: null },
      { max_duration: 0 }, { max_duration: -1 }, { max_duration: 1.5 },
      { max_duration: NaN }, { max_duration: Infinity }, { max_duration: -Infinity },
      { max_duration: Number.MAX_SAFE_INTEGER + 1 }, { max_duration: "900" },
      { max_duration: "https://private.test/?token=secret" },
      { max_duration: { toString: () => { throw new Error("Do not coerce provider values"); } } },
    ];
    for (const limits of invalidLimits) {
      for (const stage of ["analysis", "download"] as const) {
        expect(mediaFailureMessage("DURATION_LIMIT", stage, limits as { max_duration?: number } | null | undefined))
          .toBe("This video exceeds the allowed duration. Choose a shorter video.");
      }
    }
  });

  it("reads only the numeric duration field rather than provider messages", () => {
    const limits = {
      max_duration: 900,
      message: "private response https://private.test/?token=secret",
    };
    const message = mediaFailureMessage("DURATION_LIMIT", "analysis", limits);
    expect(message).toContain("current limit of 15 minutes");
    expect(message).not.toContain("private");
    expect(message).not.toContain("token");
    expect(message).not.toContain("https://");
  });

  it("does not change other failures when limits are present", () => {
    for (const code of ["DURATION_UNKNOWN", "MEDIA_LIMIT", "FILE_TOO_LARGE", "SOURCE_UNAVAILABLE", "SOURCE_TLS_ERROR", "UNKNOWN_CODE"]) {
      for (const stage of ["analysis", "download"] as const) {
        expect(mediaFailureMessage(code, stage, { max_duration: 900 })).toBe(mediaFailureMessage(code, stage));
      }
    }
  });

  it("retains duration codes and processing stages", () => {
    expect(mediaFailureReference("DURATION_LIMIT", "analysis")).toBe("Reference: DURATION_LIMIT · Stage: analysis");
    expect(mediaFailureReference("DURATION_LIMIT", "validation")).toBe("Reference: DURATION_LIMIT · Stage: validation");
  });
});
