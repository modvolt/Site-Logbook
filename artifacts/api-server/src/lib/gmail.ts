const GMAIL_CONNECTOR_NAME = "google-mail";

type ConnectionSettings = {
  access_token?: string;
  oauth?: { credentials?: { access_token?: string } };
};

async function getAccessToken(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error("Gmail není připojen (chybí přihlašovací údaje konektoru).");
  }

  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=${GMAIL_CONNECTOR_NAME}`,
    {
      headers: {
        Accept: "application/json",
        X_REPLIT_TOKEN: xReplitToken,
      },
    },
  );

  if (!res.ok) {
    throw new Error("Nepodařilo se získat přístup ke Gmailu.");
  }

  const data = (await res.json()) as { items?: Array<{ settings?: ConnectionSettings }> };
  const settings = data.items?.[0]?.settings;
  const accessToken = settings?.access_token ?? settings?.oauth?.credentials?.access_token;

  if (!accessToken) {
    throw new Error("Gmail není připojen.");
  }

  return accessToken;
}

function encodeHeaderWord(value: string): string {
  // RFC 2047 encoded-word so non-ASCII (Czech) subjects/filenames survive.
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function toBase64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type SendGmailParams = {
  to: string;
  subject: string;
  text: string;
  pdfBase64: string;
  filename: string;
};

export async function sendGmailWithPdf(params: SendGmailParams): Promise<void> {
  const accessToken = await getAccessToken();
  const { to, subject, text, pdfBase64, filename } = params;

  const boundary = `stavba_${Date.now().toString(36)}`;
  const safeFilename = encodeHeaderWord(filename);

  const mime = [
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf-8").toString("base64"),
    "",
    `--${boundary}`,
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeFilename}"`,
    "",
    pdfBase64.replace(/\r?\n/g, ""),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const raw = toBase64Url(Buffer.from(mime, "utf-8"));

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gmail odeslání selhalo (${res.status}): ${detail}`);
  }
}
