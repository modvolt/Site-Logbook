import { describe, expect, it } from "vitest";
import {
  DB_BACKED_PRIVATE_OBJECT_PREFIXES,
  TYPED_ONLY_PRIVATE_OBJECT_PREFIXES,
  classifyPrivateObjectPath,
} from "../src/lib/private-object-policy";

describe("generic private object path policy", () => {
  it.each(DB_BACKED_PRIVATE_OBJECT_PREFIXES)(
    "classifies DB-backed prefix %s",
    (prefix) => {
      expect(classifyPrivateObjectPath(`/objects/${prefix}/known-key`)).toEqual({
        kind: "db-backed",
        prefix,
      });
    },
  );

  it.each(TYPED_ONLY_PRIVATE_OBJECT_PREFIXES)(
    "keeps typed-only prefix %s off the generic route",
    (prefix) => {
      expect(classifyPrivateObjectPath(`/objects/${prefix}/known-key`)).toEqual({
        kind: "typed-only",
      });
    },
  );

  it.each([
    "",
    "/objects/",
    "/objects/uploads",
    "/objects/uploads/",
    "/objects/uploads/../secret",
    "/objects/uploads\\secret",
    "/objects/invoices-archive/file.pdf",
    "/objects/backups-old/file.dump",
    "/objects/future-prefix/file.pdf",
    "/public-objects/uploads/file.pdf",
  ])("denies malformed, look-alike or unknown path %s", (path) => {
    expect(classifyPrivateObjectPath(path)).toEqual({ kind: "unknown" });
  });
});
