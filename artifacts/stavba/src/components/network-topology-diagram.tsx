import { useMemo } from "react";
import type { NetworkDevice } from "@workspace/api-client-react";
import {
  Globe,
  Router,
  Network,
  Camera,
  Video,
  Server,
  HardDrive,
  Monitor,
  Printer,
  Phone,
  Shield,
  Wifi,
  Boxes,
  type LucideIcon,
} from "lucide-react";

/* ------------------------------------------------------------------ *
 * Layout constants (px). The diagram is laid out as a tidy top-down
 * tree and rendered as absolutely-positioned HTML cards over an SVG
 * connector layer, so it prints cleanly (no <foreignObject>).
 * ------------------------------------------------------------------ */
const NODE_W = 158;
const NODE_H = 74;
const H_GAP = 26;
const V_GAP = 58;
const PAD = 16;

export const norm = (s: string) => String(s ?? "").trim().toLowerCase();

function iconFor(deviceType: string): LucideIcon {
  const t = norm(deviceType);
  if (!t) return Boxes;
  if (t.includes("internet") || t.includes("wan") || t.includes("globe"))
    return Globe;
  if (t.includes("router") || t.includes("brán") || t.includes("gateway"))
    return Router;
  if (t.includes("switch") || t.includes("síť") || t.includes("network"))
    return Network;
  if (t.includes("firewall")) return Shield;
  if (t.includes("access point") || t.includes("ap") || t.includes("wifi"))
    return Wifi;
  if (t.includes("nvr") || t.includes("dvr") || t.includes("recorder"))
    return Video;
  if (t.includes("kamer") || t.includes("camera") || t.includes("cctv"))
    return Camera;
  if (t.includes("nas")) return HardDrive;
  if (t.includes("server")) return Server;
  if (t.includes("tisk") || t.includes("print")) return Printer;
  if (t.includes("voip") || t.includes("telefon") || t.includes("phone"))
    return Phone;
  if (t.includes("pc") || t.includes("počítač") || t.includes("monitor"))
    return Monitor;
  return Boxes;
}

type NodeKind = "device" | "phantom";

type LaidNode = {
  id: string;
  kind: NodeKind;
  deviceType: string;
  name: string;
  ipAddress: string;
  quantity: number;
  x: number;
  y: number;
};

type Edge = {
  parentId: string;
  childId: string;
  label: string;
  extra: boolean;
};

type BuiltTopology = {
  nodes: LaidNode[];
  edges: Edge[];
  width: number;
  height: number;
};

export function buildTopology(topology: NetworkDevice[]): BuiltTopology {
  const devices = topology.filter((d) => d);

  // Lookup by normalized name then ip address.
  const byName = new Map<string, NetworkDevice>();
  const byIp = new Map<string, NetworkDevice>();
  for (const d of devices) {
    const n = norm(d.name);
    if (n && !byName.has(n)) byName.set(n, d);
    const ip = norm(d.ipAddress);
    if (ip && !byIp.has(ip)) byIp.set(ip, d);
  }

  const resolve = (target: string): NetworkDevice | null => {
    const t = norm(target);
    if (!t) return null;
    return byName.get(t) ?? byIp.get(t) ?? null;
  };

  // Build directed edges device -> connectedDevice. Unmatched connection
  // strings become phantom leaf nodes (e.g. "Internet").
  type RawEdge = { from: string; to: string; label: string };
  const rawEdges: RawEdge[] = [];
  const phantoms = new Map<string, LaidNode>();
  const incoming = new Map<string, number>();

  for (const d of devices) {
    for (const p of d.ports ?? []) {
      const conn = String(p.connectedDevice ?? "").trim();
      if (!conn) continue;
      const label = [p.portNumber, p.name]
        .map((s) => String(s ?? "").trim())
        .filter((s) => s)
        .join(" · ");
      const target = resolve(conn);
      if (target) {
        if (target.id === d.id) continue; // ignore self loops
        rawEdges.push({ from: d.id, to: target.id, label });
        incoming.set(target.id, (incoming.get(target.id) ?? 0) + 1);
      } else {
        const pid = `phantom:${d.id}:${p.id}`;
        if (!phantoms.has(pid)) {
          phantoms.set(pid, {
            id: pid,
            kind: "phantom",
            deviceType: conn,
            name: conn,
            ipAddress: "",
            quantity: 1,
            x: 0,
            y: 0,
          });
        }
        rawEdges.push({ from: d.id, to: pid, label });
        incoming.set(pid, (incoming.get(pid) ?? 0) + 1);
      }
    }
  }

  // children adjacency (device ids only as parents)
  const childrenOf = new Map<string, RawEdge[]>();
  for (const e of rawEdges) {
    const arr = childrenOf.get(e.from) ?? [];
    arr.push(e);
    childrenOf.set(e.from, arr);
  }

  // Roots: devices with no incoming edge. If none (cycle), pick the device
  // with the most children, else the first device.
  let roots = devices.filter((d) => !incoming.get(d.id));
  if (roots.length === 0 && devices.length > 0) {
    const best = [...devices].sort(
      (a, b) =>
        (childrenOf.get(b.id)?.length ?? 0) - (childrenOf.get(a.id)?.length ?? 0),
    )[0];
    roots = [best];
  }

  const nodeMap = new Map<string, LaidNode>();
  for (const d of devices) {
    nodeMap.set(d.id, {
      id: d.id,
      kind: "device",
      deviceType: d.deviceType,
      name: d.name,
      ipAddress: d.ipAddress,
      quantity: d.quantity,
      x: 0,
      y: 0,
    });
  }
  for (const [pid, node] of phantoms) nodeMap.set(pid, node);

  // Spanning tree (each node placed once). Extra edges to already-visited
  // nodes are drawn as cross-links.
  const visited = new Set<string>();
  const treeChildren = new Map<string, { id: string; label: string }[]>();
  const extraEdges: Edge[] = [];

  const visit = (id: string) => {
    visited.add(id);
    const kids = childrenOf.get(id) ?? [];
    const placed: { id: string; label: string }[] = [];
    for (const e of kids) {
      if (visited.has(e.to)) {
        extraEdges.push({
          parentId: id,
          childId: e.to,
          label: e.label,
          extra: true,
        });
        continue;
      }
      placed.push({ id: e.to, label: e.label });
      visited.add(e.to);
    }
    treeChildren.set(id, placed);
    for (const k of placed) visit(k.id);
  };
  for (const r of roots) if (!visited.has(r.id)) visit(r.id);
  // Any leftover (disconnected) devices become their own roots.
  for (const d of devices)
    if (!visited.has(d.id)) {
      roots.push(d);
      visit(d.id);
    }

  // Tidy layout: leaves get sequential slots, parents are centered.
  let cursor = 0;
  const place = (id: string, depth: number) => {
    const kids = treeChildren.get(id) ?? [];
    const node = nodeMap.get(id)!;
    node.y = PAD + depth * (NODE_H + V_GAP);
    if (kids.length === 0) {
      node.x = PAD + cursor * (NODE_W + H_GAP);
      cursor += 1;
    } else {
      for (const k of kids) place(k.id, depth + 1);
      const first = nodeMap.get(kids[0].id)!;
      const last = nodeMap.get(kids[kids.length - 1].id)!;
      node.x = (first.x + last.x) / 2;
    }
  };
  for (const r of roots) place(r.id, 0);

  const treeEdges: Edge[] = [];
  for (const [pid, kids] of treeChildren)
    for (const k of kids)
      treeEdges.push({ parentId: pid, childId: k.id, label: k.label, extra: false });

  const nodes = [...nodeMap.values()];
  const width =
    Math.max(0, ...nodes.map((n) => n.x + NODE_W)) + PAD;
  const height =
    Math.max(0, ...nodes.map((n) => n.y + NODE_H)) + PAD;

  return { nodes, edges: [...treeEdges, ...extraEdges], width, height };
}

function connectorPath(p: LaidNode, c: LaidNode): string {
  const sx = p.x + NODE_W / 2;
  const sy = p.y + NODE_H;
  const tx = c.x + NODE_W / 2;
  const ty = c.y;
  const midY = sy + V_GAP / 2;
  return `M ${sx} ${sy} V ${midY} H ${tx} V ${ty}`;
}

export function NetworkTopologyDiagram({
  topology,
  className = "",
}: {
  topology: NetworkDevice[];
  className?: string;
}) {
  const built = useMemo(() => buildTopology(topology), [topology]);
  const nodeById = useMemo(() => {
    const m = new Map<string, LaidNode>();
    for (const n of built.nodes) m.set(n.id, n);
    return m;
  }, [built]);

  const hasPhantom = built.nodes.some((n) => n.kind === "phantom");
  const hasExtra = built.edges.some((e) => e.extra);

  if (built.nodes.length === 0) return null;

  return (
    <div className={`w-full overflow-x-auto ${className}`}>
      <div
        className="relative mx-auto"
        style={{ width: built.width, height: built.height, minWidth: built.width }}
      >
        <svg
          className="absolute inset-0 pointer-events-none"
          width={built.width}
          height={built.height}
          viewBox={`0 0 ${built.width} ${built.height}`}
        >
          {built.edges.map((e, i) => {
            const p = nodeById.get(e.parentId);
            const c = nodeById.get(e.childId);
            if (!p || !c) return null;
            const tx = c.x + NODE_W / 2;
            const midY = p.y + NODE_H + V_GAP / 2;
            return (
              <g key={i}>
                <path
                  d={connectorPath(p, c)}
                  fill="none"
                  stroke="#22c55e"
                  strokeWidth={e.extra ? 1.5 : 2}
                  strokeDasharray={e.extra ? "4 3" : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {e.label && (
                  <text
                    x={tx}
                    y={midY + 3}
                    textAnchor="middle"
                    fontSize={10}
                    fill="#15803d"
                    stroke="#ffffff"
                    strokeWidth={3}
                    style={{ paintOrder: "stroke" }}
                  >
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {built.nodes.map((n) => {
          const Icon = iconFor(n.kind === "phantom" ? n.name : n.deviceType);
          const phantom = n.kind === "phantom";
          return (
            <div
              key={n.id}
              className={`absolute flex flex-col items-center justify-center gap-0.5 rounded-lg border bg-white px-2 py-1.5 text-center shadow-sm dark:bg-neutral-900 ${
                phantom
                  ? "border-dashed border-emerald-300 dark:border-emerald-800"
                  : "border-neutral-200 dark:border-neutral-700"
              }`}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${
                  phantom ? "text-emerald-500" : "text-blue-500"
                }`}
              />
              <div className="w-full truncate text-xs font-semibold leading-tight">
                {n.name || (phantom ? "—" : n.deviceType || "Zařízení")}
                {!phantom && n.quantity > 1 && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    ×{n.quantity}
                  </span>
                )}
              </div>
              {!phantom && (
                <div className="w-full truncate text-[10px] leading-tight text-muted-foreground">
                  {n.deviceType}
                  {n.ipAddress ? ` · ${n.ipAddress}` : ""}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {(hasPhantom || hasExtra) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
          {hasPhantom && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-3.5 rounded-sm border border-dashed border-emerald-400" />
              Externí / neznámé zařízení
            </span>
          )}
          {hasExtra && (
            <span className="flex items-center gap-1">
              <svg width="20" height="6" aria-hidden>
                <line
                  x1="0"
                  y1="3"
                  x2="20"
                  y2="3"
                  stroke="#22c55e"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                />
              </svg>
              Křížové propojení
            </span>
          )}
        </div>
      )}
    </div>
  );
}
