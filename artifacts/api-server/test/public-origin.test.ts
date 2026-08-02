import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PublicOriginConfigError,
  publicAppOrigin,
  publicAppUrl,
} from "../src/lib/public-origin";

const originalUrl = process.env.PUBLIC_APP_URL;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalUrl == null) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = originalUrl;
  if (originalNodeEnv == null) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("trusted public application origin", () => {
  it("builds external links only from the configured canonical origin", () => {
    process.env.PUBLIC_APP_URL = "https://modvoltapp.cz/";
    expect(publicAppOrigin()).toBe("https://modvoltapp.cz");
    expect(publicAppUrl("/sign/opaque-token")).toBe(
      "https://modvoltapp.cz/sign/opaque-token",
    );
  });

  it.each([
    "",
    "ftp://modvoltapp.cz",
    "https://user:password@modvoltapp.cz",
    "https://modvoltapp.cz/untrusted-prefix",
    "https://modvoltapp.cz/?next=https://evil.example",
    "https://modvoltapp.cz/#fragment",
  ])("rejects an invalid PUBLIC_APP_URL: %s", (value) => {
    process.env.PUBLIC_APP_URL = value;
    expect(() => publicAppOrigin()).toThrowError(PublicOriginConfigError);
  });

  it("requires HTTPS in production but permits loopback HTTP in development", () => {
    process.env.PUBLIC_APP_URL = "http://localhost:5173";
    process.env.NODE_ENV = "development";
    expect(publicAppOrigin()).toBe("http://localhost:5173");

    process.env.NODE_ENV = "production";
    expect(() => publicAppOrigin()).toThrowError(/HTTPS/);
  });

  it("rejects scheme-relative or non-root-relative link input", () => {
    process.env.PUBLIC_APP_URL = "https://modvoltapp.cz";
    expect(() => publicAppUrl("//evil.example/sign/token")).toThrowError(
      PublicOriginConfigError,
    );
    expect(() => publicAppUrl("https://evil.example/sign/token")).toThrowError(
      PublicOriginConfigError,
    );
  });

  it("keeps the web edge fail-closed for unknown Host values", () => {
    const nginx = readFileSync(
      new URL("../../stavba/nginx.conf", import.meta.url),
      "utf8",
    );
    expect(nginx).toMatch(/listen \$\{NGINX_PORT\} default_server;/);
    expect(nginx).toMatch(/server_name _;\s*return 444;/);
    expect(nginx).toContain(
      "server_name ${NGINX_SERVER_NAME} localhost 127.0.0.1;",
    );

    const compose = readFileSync(
      new URL("../../../docker-compose.yml", import.meta.url),
      "utf8",
    );
    expect(compose).toContain("PUBLIC_APP_URL: ${PUBLIC_APP_URL}");
    expect(compose).toContain(
      "NGINX_SERVER_NAME: ${NGINX_SERVER_NAME:-localhost}",
    );
  });

  it("ships the production web security-header contract on every response class", () => {
    const nginx = readFileSync(
      new URL("../../stavba/nginx.conf", import.meta.url),
      "utf8",
    );
    const headers = readFileSync(
      new URL("../../stavba/security-headers.conf", import.meta.url),
      "utf8",
    );
    const dockerfile = readFileSync(
      new URL("../../stavba/Dockerfile", import.meta.url),
      "utf8",
    );

    expect(nginx.match(/include \/etc\/nginx\/security-headers\.conf;/g)).toHaveLength(3);
    expect(dockerfile).toContain("COPY artifacts/stavba/security-headers.conf /etc/nginx/security-headers.conf");
    expect(headers).toContain("Content-Security-Policy");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("object-src 'none'");
    expect(headers).toContain("base-uri 'self'");
    expect(headers).toContain("Strict-Transport-Security");
    expect(headers).toContain("Referrer-Policy");
    expect(headers).toContain("Permissions-Policy");
    expect(headers).toContain("X-Frame-Options \"DENY\"");
  });
});
