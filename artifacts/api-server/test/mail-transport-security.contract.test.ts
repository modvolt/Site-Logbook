import { describe, expect, it } from "vitest";
import { buildImapClientOptions, buildSmtpTransportOptions } from "../src/lib/mail-transport-security";

describe("mail transport TLS policy", () => {
  it("requires verified STARTTLS for a non-implicit SMTP connection", () => {
    const options = buildSmtpTransportOptions({ host: "smtp.example", port: 587, secure: false, user: "u", pass: "p", from: "u@example" });
    expect(options).toMatchObject({
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });

  it("uses verified implicit TLS without an unnecessary SMTP upgrade", () => {
    const options = buildSmtpTransportOptions({ host: "smtp.example", port: 465, secure: true, from: "u@example" });
    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBe(false);
    expect(options.tls.rejectUnauthorized).toBe(true);
  });

  it("requires verified STARTTLS for non-implicit IMAP", () => {
    const options = buildImapClientOptions({ host: "imap.example", port: 143, secure: false, user: "u", pass: "p" });
    expect(options).toMatchObject({
      secure: false,
      doSTARTTLS: true,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
  });

  it("keeps implicit IMAP TLS certificate verification enabled", () => {
    const options = buildImapClientOptions({ host: "imap.example", port: 993, secure: true });
    expect(options.secure).toBe(true);
    expect(options.doSTARTTLS).toBeUndefined();
    expect(options.tls?.rejectUnauthorized).toBe(true);
  });
});
