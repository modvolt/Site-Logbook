import nodemailer, { type Transporter } from "nodemailer";

export type SendEmailParams = {
  to: string;
  subject: string;
  text: string;
  pdfBase64: string;
  filename: string;
};

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;

  const host = process.env.SMTP_HOST;
  if (!host) {
    throw new Error(
      "SMTP není nakonfigurováno (chybí SMTP_HOST). Nastavte SMTP_HOST, " +
        "SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD a SMTP_FROM.",
    );
  }

  const port = Number(process.env.SMTP_PORT || "587");
  // secure=true uses TLS on connect (typically port 465); otherwise STARTTLS.
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === "true"
    : port === 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });
  return cachedTransporter;
}

function resolveFrom(): string {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) {
    throw new Error(
      "Odesílatel e-mailu není nastaven (SMTP_FROM nebo SMTP_USER).",
    );
  }
  return from;
}

export async function sendEmailWithPdf(params: SendEmailParams): Promise<void> {
  const { to, subject, text, pdfBase64, filename } = params;

  try {
    await getTransporter().sendMail({
      from: resolveFrom(),
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
