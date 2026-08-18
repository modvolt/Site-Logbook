import nodemailer from "nodemailer";

const subject = "F13.8A verified STARTTLS probe";
const transport = nodemailer.createTransport({
  host: "mailpit",
  port: 1025,
  secure: false,
  requireTLS: true,
  tls: {
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  },
});

await transport.verify();
await transport.sendMail({
  from: "staging@site-logbook.invalid",
  to: "f13-8a@example.invalid",
  subject,
  text: "isolated staging sandbox probe",
});

const response = await fetch("http://mailpit:8025/api/v1/messages");
if (!response.ok) {
  throw new Error(`Mailpit API returned ${response.status}`);
}
const payload = await response.json();
const found =
  Array.isArray(payload.messages) &&
  payload.messages.some((message) => message.Subject === subject);
if (!found) {
  throw new Error("sandbox message was not captured");
}

console.log("verified STARTTLS delivery and sandbox capture: PASS");
