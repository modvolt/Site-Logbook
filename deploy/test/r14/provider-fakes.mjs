import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

const HTTP_PORT = 4010;
const SMTP_PORT = 1025;
const IMAP_PORT = 1143;
const controlToken = process.env.R14_PROVIDER_CONTROL_TOKEN ?? "";

if (!controlToken || controlToken.length < 24) {
  throw new Error(
    "R14_PROVIDER_CONTROL_TOKEN must contain at least 24 characters.",
  );
}

const initialState = () => ({
  modes: { smtp: "healthy", imap: "healthy", ai: "healthy" },
  smtp: { connections: 0, messages: [] },
  imap: { connections: 0, commands: 0 },
  ai: { calls: 0 },
});
let state = initialState();

function tokenMatches(value) {
  const supplied = Buffer.from(value ?? "");
  const expected = Buffer.from(controlToken);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function json(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("control body too large");
    chunks.push(chunk);
  }
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
}

const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://provider-fakes");
  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname.startsWith("/__test/")) {
    if (!tokenMatches(request.headers["x-r14-control-token"])) {
      json(response, 403, { error: "forbidden" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/__test/state") {
      json(response, 200, state);
      return;
    }
    if (request.method === "POST" && url.pathname === "/__test/reset") {
      state = initialState();
      json(response, 200, state);
      return;
    }
    if (request.method === "POST" && url.pathname === "/__test/modes") {
      try {
        const body = await readJson(request);
        const allowed = {
          smtp: new Set(["healthy", "fail"]),
          imap: new Set(["healthy", "fail"]),
          ai: new Set(["healthy", "http500", "timeout"]),
        };
        for (const name of Object.keys(allowed)) {
          if (body[name] !== undefined) {
            if (!allowed[name].has(body[name]))
              throw new Error(`invalid ${name} mode`);
            state.modes[name] = body[name];
          }
        }
        json(response, 200, { modes: state.modes });
      } catch (error) {
        json(response, 400, {
          error: error instanceof Error ? error.message : "invalid body",
        });
      }
      return;
    }
    json(response, 404, { error: "not found" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    state.ai.calls += 1;
    if (state.modes.ai === "timeout") {
      setTimeout(() => {
        if (!response.headersSent)
          json(response, 504, { error: { message: "synthetic timeout" } });
      }, 15_000).unref();
      return;
    }
    if (state.modes.ai === "http500") {
      json(response, 500, {
        error: { message: "synthetic provider failure", type: "r14_fault" },
      });
      return;
    }
    json(response, 200, {
      id: `chatcmpl-r14-${state.ai.calls}`,
      object: "chat.completion",
      created: 2_000_000_000,
      model: "r14-deterministic-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return;
  }

  json(response, 404, { error: "not found" });
});

function smtpReply(socket, line) {
  socket.write(`${line}\r\n`);
}

const smtpServer = createTcpServer((socket) => {
  state.smtp.connections += 1;
  if (state.modes.smtp === "fail") {
    smtpReply(socket, "421 R14 synthetic SMTP failure");
    socket.end();
    return;
  }
  smtpReply(socket, "220 provider-fakes ESMTP R14");
  let buffer = "";
  let dataMode = false;
  let dataLines = [];
  let mailFrom = null;
  let recipients = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (dataMode) {
        if (line === ".") {
          const body = dataLines.join("\r\n");
          const subject = /^Subject:\s*(.*)$/im.exec(body)?.[1]?.trim() ?? null;
          state.smtp.messages.push({
            sequence: state.smtp.messages.length + 1,
            from: mailFrom,
            to: [...recipients],
            subject,
            bytes: Buffer.byteLength(body),
            sha256: createHash("sha256").update(body).digest("hex"),
          });
          dataMode = false;
          dataLines = [];
          smtpReply(socket, "250 2.0.0 queued as R14");
        } else {
          dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        }
        continue;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
        smtpReply(socket, "250-provider-fakes");
        smtpReply(socket, "250 SIZE 1048576");
      } else if (upper.startsWith("MAIL FROM:")) {
        mailFrom = line.slice(line.indexOf(":") + 1).trim();
        recipients = [];
        smtpReply(socket, "250 2.1.0 sender ok");
      } else if (upper.startsWith("RCPT TO:")) {
        recipients.push(line.slice(line.indexOf(":") + 1).trim());
        smtpReply(socket, "250 2.1.5 recipient ok");
      } else if (upper === "DATA") {
        dataMode = true;
        dataLines = [];
        smtpReply(socket, "354 End data with <CR><LF>.<CR><LF>");
      } else if (upper === "RSET" || upper === "NOOP") {
        smtpReply(socket, "250 2.0.0 ok");
      } else if (upper === "QUIT") {
        smtpReply(socket, "221 2.0.0 bye");
        socket.end();
      } else {
        smtpReply(socket, "250 2.0.0 ok");
      }
    }
  });
});

function imapReply(socket, line) {
  socket.write(`${line}\r\n`);
}

const imapServer = createTcpServer((socket) => {
  state.imap.connections += 1;
  if (state.modes.imap === "fail") {
    imapReply(socket, "* BYE R14 synthetic IMAP failure");
    socket.end();
    return;
  }
  imapReply(
    socket,
    "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] provider-fakes R14 ready",
  );
  let buffer = "";
  let pendingAuthTag = null;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      state.imap.commands += 1;
      if (pendingAuthTag) {
        imapReply(socket, `${pendingAuthTag} OK AUTHENTICATE completed`);
        pendingAuthTag = null;
        continue;
      }
      const separator = line.indexOf(" ");
      const tag = separator > 0 ? line.slice(0, separator) : "R14";
      const command = separator > 0 ? line.slice(separator + 1) : line;
      const upper = command.toUpperCase();
      if (upper.startsWith("CAPABILITY")) {
        imapReply(socket, "* CAPABILITY IMAP4rev1 AUTH=PLAIN");
        imapReply(socket, `${tag} OK CAPABILITY completed`);
      } else if (upper.startsWith("AUTHENTICATE PLAIN")) {
        if (command.trim().split(/\s+/).length < 3) {
          pendingAuthTag = tag;
          imapReply(socket, "+");
        } else {
          imapReply(socket, `${tag} OK AUTHENTICATE completed`);
        }
      } else if (upper.startsWith("LOGIN")) {
        imapReply(socket, `${tag} OK LOGIN completed`);
      } else if (upper.startsWith("ID ")) {
        imapReply(socket, '* ID ("name" "R14 provider fake")');
        imapReply(socket, `${tag} OK ID completed`);
      } else if (upper.startsWith("NAMESPACE")) {
        imapReply(socket, '* NAMESPACE (("" "/")) NIL NIL');
        imapReply(socket, `${tag} OK NAMESPACE completed`);
      } else if (upper.startsWith("LIST") || upper.startsWith("LSUB")) {
        imapReply(socket, '* LIST (\\HasNoChildren) "/" "INBOX"');
        imapReply(socket, `${tag} OK LIST completed`);
      } else if (upper.startsWith("SELECT") || upper.startsWith("EXAMINE")) {
        imapReply(
          socket,
          "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)",
        );
        imapReply(socket, "* 0 EXISTS");
        imapReply(socket, "* 0 RECENT");
        imapReply(socket, "* OK [UIDVALIDITY 1] stable");
        imapReply(socket, "* OK [UIDNEXT 1] predicted next UID");
        imapReply(socket, `${tag} OK [READ-WRITE] SELECT completed`);
      } else if (upper.startsWith("STATUS")) {
        imapReply(
          socket,
          '* STATUS "INBOX" (MESSAGES 0 UNSEEN 0 UIDNEXT 1 UIDVALIDITY 1)',
        );
        imapReply(socket, `${tag} OK STATUS completed`);
      } else if (upper.startsWith("SEARCH") || upper.startsWith("UID SEARCH")) {
        imapReply(socket, "* SEARCH");
        imapReply(socket, `${tag} OK SEARCH completed`);
      } else if (upper.startsWith("NOOP") || upper.startsWith("CLOSE")) {
        imapReply(socket, `${tag} OK completed`);
      } else if (upper.startsWith("LOGOUT")) {
        imapReply(socket, "* BYE logging out");
        imapReply(socket, `${tag} OK LOGOUT completed`);
        socket.end();
      } else {
        imapReply(socket, `${tag} OK R14 accepted`);
      }
    }
  });
});

await Promise.all([
  new Promise((resolve) => httpServer.listen(HTTP_PORT, "0.0.0.0", resolve)),
  new Promise((resolve) => smtpServer.listen(SMTP_PORT, "0.0.0.0", resolve)),
  new Promise((resolve) => imapServer.listen(IMAP_PORT, "0.0.0.0", resolve)),
]);

async function shutdown() {
  await Promise.all([
    new Promise((resolve) => httpServer.close(resolve)),
    new Promise((resolve) => smtpServer.close(resolve)),
    new Promise((resolve) => imapServer.close(resolve)),
  ]);
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
