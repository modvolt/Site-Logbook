---
name: Wouter useParams outside Route
description: useParams() silently returns {} when a component is rendered via a manual startsWith/conditional branch instead of inside a <Route> — page hangs on loading state.
---

## Rule

Never use `useParams()` in a component that is conditionally rendered by a manual `path.startsWith(...)` guard in the Router. Without a `<Route path=".../:param">` ancestor, wouter never populates the param context — `useParams()` returns `{}` and the token/id is `undefined`.

**Why:** Wouter's `useParams` reads from a React context that is only set by the `<Route>` component's match. A raw `if (path.startsWith("/foo/"))` check bypasses that context entirely.

**How to apply:** When the Router conditionally renders a public page (e.g. a sign/confirm page served by `startsWith`), extract the path segment using `useLocation()`:

```tsx
const SIGN_PREFIX = "/oopp/sign/";
const [path] = useLocation();
const token = path.startsWith(SIGN_PREFIX) ? path.slice(SIGN_PREFIX.length) : "";
```

Alternatively, wrap the render in a proper `<Route path="/oopp/sign/:token">` so `useParams` works normally.

Affected page at time of discovery: `artifacts/stavba/src/pages/oopp-sign.tsx` — rendered via the `path.startsWith("/oopp/sign/")` branch in `Router()`.
