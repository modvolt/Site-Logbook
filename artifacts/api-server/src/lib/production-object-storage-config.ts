import { createHash } from "node:crypto";

export type ProductionHetznerObjectStorageRegion = "fsn1" | "nbg1" | "hel1";

export type ProductionHetznerObjectStorageEndpointBinding = Readonly<{
  kind: "hetzner-object-storage";
  endpointOriginSha256: string;
  region: ProductionHetznerObjectStorageRegion;
  encryptionBoundary: "client-envelope-only";
  transport: "https";
  versioning: "enabled";
}>;

export type ProductionHetznerObjectStorageConfiguration = Readonly<{
  storageProvider: ProductionHetznerObjectStorageEndpointBinding;
  bucket: string;
  forcePathStyle: false;
}>;

const HETZNER_REGIONS = new Set<ProductionHetznerObjectStorageRegion>([
  "fsn1",
  "nbg1",
  "hel1",
]);

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requiredExact(
  env: NodeJS.ProcessEnv,
  key: string,
  maximumLength: number,
): string {
  const value = env[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error(
      `PRODUCTION_HETZNER_OBJECT_STORAGE_INVALID: ${key} is missing or is not canonical.`,
    );
  }
  return value;
}

export function parseProductionHetznerObjectStorageEndpoint(
  endpointInput: string | undefined,
  regionInput: string | undefined,
): ProductionHetznerObjectStorageEndpointBinding {
  if (
    typeof endpointInput !== "string" ||
    endpointInput.length === 0 ||
    endpointInput !== endpointInput.trim() ||
    typeof regionInput !== "string" ||
    !HETZNER_REGIONS.has(regionInput as ProductionHetznerObjectStorageRegion)
  ) {
    throw new Error(
      "PRODUCTION_HETZNER_OBJECT_STORAGE_INVALID: an explicit Hetzner endpoint and supported region are required.",
    );
  }

  const parsed = new URL(endpointInput);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname !== `${regionInput}.your-objectstorage.com` ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "PRODUCTION_HETZNER_OBJECT_STORAGE_INVALID: the canonical HTTPS Hetzner endpoint must match its region.",
    );
  }

  return Object.freeze({
    kind: "hetzner-object-storage" as const,
    endpointOriginSha256: sha256(parsed.origin),
    region: regionInput as ProductionHetznerObjectStorageRegion,
    encryptionBoundary: "client-envelope-only" as const,
    transport: "https" as const,
    versioning: "enabled" as const,
  });
}

export function requireProductionHetznerObjectStorageConfiguration(
  env: NodeJS.ProcessEnv,
): ProductionHetznerObjectStorageConfiguration {
  const storageProvider = parseProductionHetznerObjectStorageEndpoint(
    requiredExact(env, "S3_ENDPOINT", 256),
    requiredExact(env, "S3_REGION", 16),
  );
  const bucket = requiredExact(env, "S3_BUCKET", 63);
  if (
    bucket.length < 3 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(bucket) ||
    bucket.includes("..") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bucket)
  ) {
    throw new Error(
      "PRODUCTION_HETZNER_OBJECT_STORAGE_INVALID: S3_BUCKET must be a canonical DNS-compatible bucket name.",
    );
  }

  requiredExact(env, "S3_ACCESS_KEY_ID", 256);
  requiredExact(env, "S3_SECRET_ACCESS_KEY", 1024);
  if (env.S3_FORCE_PATH_STYLE !== "false") {
    throw new Error(
      "PRODUCTION_HETZNER_OBJECT_STORAGE_INVALID: S3_FORCE_PATH_STYLE must be exactly false.",
    );
  }

  return Object.freeze({
    storageProvider,
    bucket,
    forcePathStyle: false as const,
  });
}
