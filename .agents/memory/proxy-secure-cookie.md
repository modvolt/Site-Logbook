---
name: Secure session cookie behind a TLS-terminating proxy chain
description: Why login silently fails in production when X-Forwarded-Proto is overwritten before reaching Express
---

# Secure cookie lost behind a double proxy (Coolify/Traefik → nginx → API)

Symptom: in production the user logs in successfully (login POST returns 200 +
user) but the SPA immediately bounces back to the login screen; `GET
/api/auth/me` returns `authenticated:false`. Works fine in local dev.

**Cause:** TLS is terminated by an upstream proxy (Coolify's Traefik) that
forwards to the `web` nginx over plain HTTP. The internal nginx then proxied to
the API with `X-Forwarded-Proto $scheme` (= `http`, the *internal* hop's
scheme), overwriting the real `https`. Express (`trust proxy` on,
`cookie.secure: true`) saw an "insecure" request and **silently refused to send
the Set-Cookie** — the browser never stored the session cookie.

**Rule:** in a multi-hop proxy chain, the inner nginx must *pass through* the
incoming `X-Forwarded-Proto`, never overwrite it with `$scheme`.

**How to apply:**
- nginx: add an http-context `map $http_x_forwarded_proto $forwarded_proto {
  default $http_x_forwarded_proto; "" $scheme; }` (a `map` is only legal in
  `http{}`; `conf.d/*.conf` is included inside `http{}`, so put it at the top of
  the template, before `server{}`). Forward `$forwarded_proto` to the API.
- express-session: prefer `cookie.secure: "auto"` over a hard `true`. With
  `trust proxy` it marks the cookie Secure over real HTTPS but still works over
  plain HTTP (local docker compose), instead of hard-dropping the cookie when
  the forwarded proto is ever misread.
- Verify after deploy: browser devtools → the login response `Set-Cookie` must
  show `Secure; HttpOnly; SameSite=Lax` over HTTPS.
