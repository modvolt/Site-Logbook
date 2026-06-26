---
name: Network topology diagram
description: How the "Lokální síť" credential topology is turned into a visual tree, and the rendering/direction decisions behind it.
---

# Network topology diagram (credential vault "Lokální síť")

`NetworkTopologyDiagram` (artifacts/stavba/src/components) turns a
`device_credentials.network_topology` (NetworkDevice[]) into a top-down tree,
used in both the admin page and the customer export/handover page.

## Edge direction is data-driven, not inferred
Connections come from free-text `port.connectedDevice` strings, resolved to a
device by **name first, then ipAddress** (normalized, first-match-wins).
Edge semantics: **device → its connectedDevice = parent → child** (the device
that lists a port is the parent; what's plugged into that port hangs below).
Unmatched strings (e.g. "Internet") become **phantom leaf nodes**, which is how
the internet/external box appears without being a real credential row.

**Why:** with free text there's no reliable way to know "up vs down"; this rule
is deterministic and lets the user shape the tree by how they fill ports.

## Render HTML cards over an SVG connector layer — never `<foreignObject>`
Node cards are absolutely-positioned HTML divs; only the elbow connector lines
(and edge/port labels) are SVG, behind the cards.
**Why:** the customer export page is printed/exported to PDF, and `<foreignObject>`
renders unreliably in print. HTML-over-SVG prints fine. Wide diagrams still clip
in print — accepted tradeoff: the textual table below is the authoritative print
content; the diagram is "mainly for PC display" per the user.

## Robustness rules baked into buildTopology
- Roots = devices with **no incoming edge**; pure-cycle fallback = highest
  out-degree, then first device. Disconnected devices become their own roots.
- Spanning tree via a `visited` set; back-edges to already-placed nodes are drawn
  as **dashed cross-links**, not recursed into (prevents infinite loops).
- Known limit: duplicate device names/IPs resolve first-match-wins, so a
  duplicate name can visually link to the "wrong" twin. Acceptable for MVP.
