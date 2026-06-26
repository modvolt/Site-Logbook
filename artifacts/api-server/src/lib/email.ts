import nodemailer, { type Transporter } from "nodemailer";
import { eq } from "drizzle-orm";
import { db, emailSettingsTable } from "@workspace/db";

export type SendEmailParams = {
  to: string | string[];
  subject: string;
  text: string;
  pdfBase64: string;
  filename: string;
};

export type ResolvedEmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

const SINGLETON_ID = 1;

let cached: { sig: string; transporter: Transporter } | null = null;

async function loadDbSettings() {
  const [row] = await db
    .select()
    .from(emailSettingsTable)
    .where(eq(emailSettingsTable.id, SINGLETON_ID));
  return row;
}

function formatFrom(address: string, name: string | null | undefined): string {
  const trimmedName = name?.trim();
  return trimmedName ? `${trimmedName} <${address}>` : address;
}

/**
 * Resolve the active outgoing-mail configuration. Prefers the DB-backed config
 * (editable from Settings, works in production without redeploy) and falls back
 * to the SMTP_* environment variables when no enabled config is stored.
 */
export async function resolveEmailConfig(): Promise<ResolvedEmailConfig> {
  const row = await loadDbSettings();

  if (row?.enabled && row.host) {
    const address = row.fromAddress?.trim() || row.username?.trim();
    if (!address) {
      throw new Error(
        "Odesílatel e-mailu není nastaven. Vyplňte adresu odesílatele v sekci Nastavení.",
      );
    }
    const user = row.username?.trim() || undefined;
    return {
      host: row.host,
      port: row.port ?? 587,
      secure: row.secure ?? row.port === 465,
      user,
      pass: user ? row.password ?? undefined : undefined,
      from: formatFrom(address, row.fromName),
    };
  }

  const host = process.env.SMTP_HOST;
  if (!host) {
    throw new Error(
      "E-mail není nakonfigurován. Nastavte odesílání e-mailů v sekci Nastavení " +
        "(nebo přes proměnné prostředí SMTP_*).",
    );
  }

  const port = Number(process.env.SMTP_PORT || "587");
  // secure=true uses TLS on connect (typically port 465); otherwise STARTTLS.
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === "true"
    : port === 465;
  const user = process.env.SMTP_USER;
  const address = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!address) {
    throw new Error(
      "Odesílatel e-mailu není nastaven (SMTP_FROM nebo SMTP_USER).",
    );
  }

  return {
    host,
    port,
    secure,
    user: user || undefined,
    pass: user ? process.env.SMTP_PASSWORD : undefined,
    from: address,
  };
}

function getTransporter(cfg: ResolvedEmailConfig): Transporter {
  const sig = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
  if (cached && cached.sig === sig) return cached.transporter;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  cached = { sig, transporter };
  return transporter;
}

export async function sendEmailWithPdf(params: SendEmailParams): Promise<void> {
  const { to, subject, text, pdfBase64, filename } = params;
  const cfg = await resolveEmailConfig();

  try {
    await getTransporter(cfg).sendMail({
      from: cfg.from,
      to,
      subject,
      text,
      attachments: [
        {
          filename,
          content: Buffer.from(pdfBase64, "base64"),
          contentType: "application/pdf",
        },
      ],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Odeslání e-mailu selhalo: ${detail}`);
  }
}

/**
 * Verify the active configuration and send a short test message. Used by the
 * Settings page so admins can confirm e-mail works before relying on it.
 */
export async function sendTestEmail(to: string): Promise<void> {
  const cfg = await resolveEmailConfig();
  const transporter = getTransporter(cfg);

  try {
    await transporter.verify();
    await transporter.sendMail({
      from: cfg.from,
      to,
      subject: "Test odesílání e-mailů – Stavba",
      text:
        "Toto je testovací e-mail z aplikace Stavba.\n\n" +
        "Pokud jste jej obdrželi, odesílání e-mailů je správně nastaveno.",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Odeslání testovacího e-mailu selhalo: ${detail}`);
  }
}
