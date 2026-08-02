import type { ImapFlowOptions } from "imapflow";

type MailServerConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
};

export function buildSmtpTransportOptions(cfg: MailServerConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // Port 587-style connections must upgrade; silently continuing in
    // cleartext would expose credentials and message contents.
    requireTLS: !cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2" as const,
    },
    // Defence in depth for all generated messages: no attachment or body field
    // may dereference local files or remote URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function buildImapClientOptions(cfg: MailServerConfig): ImapFlowOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // Non-implicit-TLS ports must advertise and complete STARTTLS. ImapFlow
    // otherwise permits cleartext when STARTTLS is unavailable.
    ...(cfg.secure ? {} : { doSTARTTLS: true }),
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : { user: "", pass: "" },
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    logger: false,
    disableAutoIdle: true,
  };
}
