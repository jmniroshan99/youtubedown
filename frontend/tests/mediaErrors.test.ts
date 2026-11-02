import { describe, expect, it } from "vitest";
import { mediaFailureMessage } from "../src/mediaErrors";

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
});
