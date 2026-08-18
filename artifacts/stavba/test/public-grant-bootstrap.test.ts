import { beforeEach, describe, expect, it } from "vitest";
import {
  capturePublicGrantLocation,
  clearPublicGrant,
  publicGrantToken,
  requiresPublicGrantReload,
  retainPublicGrantForRoutePath,
  type PublicGrantPurpose,
} from "../src/lib/public-grant-bootstrap";

const token = "A".repeat(43);

function capture(pathname: string, search = "", hash = "") {
  const replacements: string[] = [];
  const result = capturePublicGrantLocation(
    { pathname, search, hash } as Pick<Location, "pathname" | "search" | "hash">,
    (path) => replacements.push(path),
  );
  return { result, replacements };
}

beforeEach(() => clearPublicGrant());

describe("public grant bootstrap", () => {
  it.each([
    ["/sign/", "/sign", "job_signature"],
    ["/oopp/sign/", "/oopp/sign", "ppe_signature"],
    ["/quote-share/", "/quote-share", "quote"],
    ["/q/board/", "/q/board", "switchboard"],
  ] as const)("captures legacy %sTOKEN before rendering", (prefix, canonical, purpose) => {
    const { result, replacements } = capture(`${prefix}${token}`);
    expect(result).toEqual({ publicRoute: true, captured: true, canonicalPath: canonical });
    expect(replacements).toEqual([canonical]);
    expect(publicGrantToken(purpose as PublicGrantPurpose)).toBe(token);
  });

  it("captures and removes the legacy PPE query credential", () => {
    const { replacements } = capture("/oopp/potvrdit", `?token=${token}`);
    expect(replacements).toEqual(["/oopp/potvrdit"]);
    expect(publicGrantToken("ppe_confirmation")).toBe(token);
  });

  it("captures canonical fragment links and immediately removes the fragment", () => {
    const { replacements } = capture("/sign", "", `#token=${token}`);
    expect(replacements).toEqual(["/sign"]);
    expect(publicGrantToken("job_signature")).toBe(token);
  });

  it("fails closed and still cleans malformed or ambiguous locations", () => {
    expect(capture("/sign/not-valid", "", `#token=${token}`).replacements)
      .toEqual(["/sign"]);
    expect(publicGrantToken("job_signature")).toBeNull();

    expect(capture("/oopp/potvrdit", "?token=a&token=b").replacements)
      .toEqual(["/oopp/potvrdit"]);
    expect(publicGrantToken("ppe_confirmation")).toBeNull();
  });

  it("does not restore a credential on canonical reload", () => {
    const { result, replacements } = capture("/quote-share");
    expect(result).toEqual({
      publicRoute: true,
      captured: false,
      canonicalPath: "/quote-share",
    });
    expect(replacements).toEqual([]);
    expect(publicGrantToken("quote")).toBeNull();
  });

  it("ignores unrelated application routes", () => {
    capture("/sign", "", `#token=${token}`);
    expect(capture("/jobs/42").result).toEqual({ publicRoute: false, captured: false });
    expect(publicGrantToken("job_signature")).toBeNull();
  });

  it("supports a configured Vite base path while cleaning the browser URL", () => {
    const replacements: string[] = [];
    const result = capturePublicGrantLocation(
      { pathname: "/app/sign", search: "", hash: `#token=${token}` } as Location,
      (path) => replacements.push(path),
      "/app/",
    );
    expect(result).toEqual({
      publicRoute: true,
      captured: true,
      canonicalPath: "/sign",
    });
    expect(replacements).toEqual(["/app/sign"]);
    expect(publicGrantToken("job_signature")).toBe(token);
  });

  it("clears a grant synchronously when the rendered route changes", () => {
    capture("/sign", "", `#token=${token}`);
    retainPublicGrantForRoutePath("/quote-share");
    expect(publicGrantToken("job_signature")).toBeNull();

    capture("/sign", "", `#token=${token}`);
    retainPublicGrantForRoutePath("/jobs/42");
    expect(publicGrantToken("job_signature")).toBeNull();
  });

  it("forces a fresh page tree for a second fragment grant in the same tab", () => {
    expect(requiresPublicGrantReload({
      pathname: "/sign",
      hash: `#token=${token}`,
    } as Location)).toBe(true);
    expect(requiresPublicGrantReload({
      pathname: "/quote-share",
      hash: token,
    } as Location)).toBe(true);
    expect(requiresPublicGrantReload({
      pathname: "/sign",
      hash: "#ordinary-section",
    } as Location)).toBe(false);
    expect(requiresPublicGrantReload({
      pathname: "/jobs/42",
      hash: `#token=${token}`,
    } as Location)).toBe(false);
  });
});
