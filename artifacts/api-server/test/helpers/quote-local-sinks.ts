import { createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Loopback-only protocol sinks: real nodemailer/AWS SDK traffic, no relay. */
export async function quoteLocalSinks() {
  const emails: { recipient: string; raw: string }[] = [];
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const sockets = new Set<Socket>();
  let rejectMail = false;
  const smtp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 localhost quote test sink\r\n");
    let pending = "",
      data = false,
      raw = "",
      recipient = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === ".") {
            emails.push({ recipient, raw });
            data = false;
            raw = "";
            socket.write("250 accepted locally\r\n");
          } else raw += line.replace(/^\.\./, ".") + "\r\n";
        } else if (/^(EHLO|HELO)/.test(line))
          socket.write("250-localhost\r\n250 8BITMIME\r\n");
        else if (line.startsWith("RCPT")) {
          recipient = line;
          socket.write(rejectMail ? "550 test refusal\r\n" : "250 ok\r\n");
        } else if (line === "DATA") {
          data = true;
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  const storage = createHttpServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    calls.push(`${req.method} ${path}`);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(path, Buffer.concat(chunks));
      res.setHeader("ETag", '"local-test"');
      res.end();
    } else if (req.method === "DELETE") {
      objects.delete(path);
      res.statusCode = 204;
      res.end();
    } else {
      const bytes = objects.get(path);
      if (!bytes) {
        res.statusCode = 404;
        res.end();
      } else {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Length", bytes.length);
        res.end(req.method === "HEAD" ? undefined : bytes);
      }
    }
  });
  await Promise.all([
    new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve)),
  ]);
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String((smtp.address() as AddressInfo).port),
    SMTP_FROM: "supplier@example.test",
    SMTP_SECURE: "false",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    MAIL_TEST_ALLOW_INSECURE: "true",
    S3_ENDPOINT: `http://127.0.0.1:${(storage.address() as AddressInfo).port}`,
    S3_BUCKET: "quote-test",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "local-test",
    S3_SECRET_ACCESS_KEY: "local-test",
    S3_FORCE_PATH_STYLE: "true",
    AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
  });
  return {
    emails,
    objects,
    calls,
    refuse: (value: boolean) => {
      rejectMail = value;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => smtp.close(() => resolve())),
        new Promise<void>((resolve) => storage.close(() => resolve())),
      ]);
    },
  };
}

export function decodeEmail(raw: string) {
  const unfolded = raw.replace(/\r\n[ \t]+/g, " ");
  const boundary = /boundary="([^"]+)"/.exec(unfolded)![1];
  const parts = raw.split(`--${boundary}`);
  const decode = (part: string) => {
    const [header, ...body] = part.replace(/^\r\n/, "").split("\r\n\r\n");
    const text = body.join("\r\n\r\n").trim();
    if (/base64/i.test(header))
      return Buffer.from(text.replace(/\s/g, ""), "base64");
    if (/quoted-printable/i.test(header))
      return Buffer.from(
        text
          .replace(/=\r\n/g, "")
          .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16)),
          ),
        "binary",
      );
    return Buffer.from(text);
  };
  return {
    pdf: decode(parts.find((p) => /Content-Type: application\/pdf/i.test(p))!),
    text: decode(
      parts.find((p) => /Content-Type: text\/plain/i.test(p))!,
    ).toString("utf8"),
    headers: unfolded.split("\r\n\r\n")[0],
  };
}
