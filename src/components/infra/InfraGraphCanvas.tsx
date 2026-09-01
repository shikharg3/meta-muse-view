import "@xyflow/react/dist/style.css";
import Dagre from "@dagrejs/dagre";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Building,
  CreditCard,
  Crosshair,
  Flag,
  IdCard,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { RiskBadge } from "@/components/infra/RiskBadge";
import {
  INFRA_NODE_KINDS,
  focusOnRisk,
  neighbourhood,
  subgraph,
  type InfraGraph,
  type InfraGraphNode,
  type InfraNodeKind,
  type InfraRelation,
} from "@/lib/infra-graph";
import type { RiskLevel } from "@/lib/infra-risk";
import { INFRA_STATUS_LABEL } from "@/lib/infra-status";
import { cn } from "@/lib/utils";

/**
 * The registry drawn as the access graph it actually is.
 *
 * Nodes are fixed-size and positioned by dagre in a left-to-right rank order, so the picture reads the
 * way access flows: profiles admin BMs, BMs reach ad accounts, pixels and pages hang off whichever of
 * the two owns them. A dashed red edge is a link that exists but cannot carry access — an asset with
 * nothing but dashed edges into it is unreachable, which is the entire point of drawing this.
 *
 * Nodes are NOT draggable. Layout is derived state, so making it editable would mean mirroring dagre's
 * output into component state and reconciling it on every filter change; the graph is read-only
 * triage, and pan, zoom and the minimap cover the navigation this needs.
 */

const NODE_W = 232;
const NODE_H = 64;

const KIND: Record<InfraNodeKind, { label: string; icon: LucideIcon; to: string }> = {
  profile: { label: "Profile", icon: IdCard, to: "/infrastructure/profiles" },
  bm: { label: "Business Manager", icon: Building, to: "/infrastructure/business-managers" },
  adAccount: { label: "Ad Account", icon: CreditCard, to: "/infrastructure/ad-accounts" },
  pixel: { label: "Pixel", icon: Crosshair, to: "/infrastructure/pixels" },
  page: { label: "Page", icon: Flag, to: "/infrastructure/pages" },
};

const RISK_RING: Record<RiskLevel, string> = {
  critical: "border-destructive/70 bg-destructive/[0.07]",
  warning: "border-warning/60 bg-warning/[0.06]",
  safe: "border-border bg-card",
};

const RISK_DOT: Record<RiskLevel, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  safe: "bg-success",
};

/** Minimap swatches. Hex, not a CSS variable: the minimap paints to canvas, which cannot resolve one. */
const RISK_HEX: Record<RiskLevel, string> = {
  critical: "#f0555f",
  warning: "#e8b13a",
  safe: "#3f4657",
};

/**
 * `owns` and `root` are the one structural parent an entity has; the rest are M:N grants. Drawing the
 * parent heavier is what stops a page with six shares from looking like it has six owners.
 */
const RELATION_STYLE: Record<InfraRelation, { width: number; dash?: string; label: string }> = {
  admin: { width: 1.5, label: "admins" },
  owns: { width: 2, label: "owns" },
  root: { width: 2, label: "roots" },
  share: { width: 1.25, dash: "6 4", label: "shares" },
  access: { width: 1.5, label: "has access to" },
};

type FlowData = { node: InfraGraphNode; dimmed: boolean };
type FlowNode = Node<FlowData, "infra">;

function InfraFlowNode({ data }: NodeProps<FlowNode>) {
  const { node, dimmed } = data;
  const Icon = KIND[node.kind].icon;
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 shadow-sm transition-opacity",
        RISK_RING[node.risk.level],
        dimmed && "opacity-15",
      )}
      // Sizes are inline because dagre is told the same numbers; a Tailwind class here could drift
      // from the layout and silently overlap nodes.
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-border" />
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", RISK_DOT[node.risk.level])} />
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate text-[12px] font-semibold leading-tight">{node.name}</span>
        {node.overdue && <span className="ml-auto text-[9px] text-warning">overdue</span>}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {INFRA_STATUS_LABEL[node.status] ?? node.status} · {node.risk.label}
      </div>
      <div className="truncate text-[10px] text-muted-foreground/70">{node.detail}</div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-border" />
    </div>
  );
}

const nodeTypes = { infra: InfraFlowNode };

/**
 * How many nodes one rank may stack before it is wrapped into sub-columns.
 *
 * Dagre ranks a graph but puts no bound on a rank's height, and this registry fans hard: every
 * profile shares rank 0, every owned page shares the next. Forty nodes in a column is 3,800px against
 * a viewport two ranks wide, so `fitView` lands at a zoom where nothing is legible. Wrapping trades
 * dagre's exact y-alignment for an aspect ratio a screen can show, keeping the within-rank ORDER —
 * which is the part that minimises edge crossings.
 */
const RANK_CAP = 12;
const COL_GAP = 36;
const ROW_GAP = 14;
const RANK_GAP = 150;

/** Positions keyed by node id, converted from dagre's centre anchor to React Flow's top-left. */
function layoutPositions(graph: InfraGraph): Record<string, { x: number; y: number }> {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", ranksep: RANK_GAP, nodesep: ROW_GAP, marginx: 40, marginy: 40 });
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of graph.edges) g.setEdge(e.source, e.target);
  Dagre.layout(g);

  // Under `rankdir: LR` every node in a rank shares a centre x, so x buckets ARE the ranks.
  const ranks = new Map<number, { id: string; y: number }[]>();
  for (const n of graph.nodes) {
    const p = g.node(n.id);
    const bucket = ranks.get(p.x);
    if (bucket) bucket.push({ id: n.id, y: p.y });
    else ranks.set(p.x, [{ id: n.id, y: p.y }]);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  const tallest = Math.max(0, ...[...ranks.values()].map((r) => r.length));
  if (tallest <= RANK_CAP) {
    // Small enough to show as dagre drew it, alignment and all.
    for (const n of graph.nodes) {
      const p = g.node(n.id);
      positions[n.id] = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
    }
    return positions;
  }

  let cursorX = 0;
  for (const rankX of [...ranks.keys()].sort((a, b) => a - b)) {
    const members = [...(ranks.get(rankX) ?? [])].sort((a, b) => a.y - b.y);
    const columns = Math.ceil(members.length / RANK_CAP);
    const perColumn = Math.ceil(members.length / columns);
    members.forEach((m, i) => {
      positions[m.id] = {
        x: cursorX + Math.floor(i / perColumn) * (NODE_W + COL_GAP),
        y: (i % perColumn) * (NODE_H + ROW_GAP),
      };
    });
    cursorX += columns * (NODE_W + COL_GAP) + RANK_GAP;
  }
  return positions;
}

/**
 * `minZoom` is a legibility floor, not a limit: a graph too big to fit whole opens at a readable
 * scale showing its top-left, and the minimap plus panning cover the rest. Fitting it entirely would
 * render a wall of unreadable rectangles. `maxZoom` stops a two-node graph filling the screen.
 */
const FIT = { padding: 0.15, minZoom: 0.42, maxZoom: 1, duration: 250 } as const;

function Canvas({ graph }: { graph: InfraGraph }) {
  const { fitView } = useReactFlow();
  const [riskOnly, setRiskOnly] = useState(true);
  const [hidden, setHidden] = useState<ReadonlySet<InfraNodeKind>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const visible = useMemo(() => {
    const shown = subgraph(
      graph,
      new Set(graph.nodes.filter((n) => !hidden.has(n.kind)).map((n) => n.id)),
    );
    return riskOnly ? focusOnRisk(shown) : shown;
  }, [graph, hidden, riskOnly]);

  const positions = useMemo(() => layoutPositions(visible), [visible]);
  // Dagre never has to run again just because the selection changed, so it is deliberately not in here.
  const near = useMemo(
    () => (selected ? neighbourhood(visible, selected) : null),
    [visible, selected],
  );

  const nodes = useMemo<FlowNode[]>(
    () =>
      visible.nodes.map((n) => ({
        id: n.id,
        type: "infra",
        position: positions[n.id],
        width: NODE_W,
        height: NODE_H,
        selected: n.id === selected,
        data: { node: n, dimmed: near !== null && !near.has(n.id) },
      })),
    [visible.nodes, positions, near, selected],
  );

  const edges = useMemo<Edge[]>(
    () =>
      visible.edges.map((e) => {
        const style = RELATION_STYLE[e.relation];
        const lit = near === null || (near.has(e.source) && near.has(e.target));
        const colour = e.dead ? "var(--destructive)" : "var(--muted-foreground)";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          style: {
            stroke: colour,
            strokeWidth: style.width,
            strokeDasharray: e.dead ? "5 4" : style.dash,
            opacity: lit ? (e.dead ? 0.9 : 0.45) : 0.07,
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: colour },
        };
      }),
    [visible.edges, near],
  );

  // Refit whenever the drawn subgraph changes, otherwise a filter can leave the viewport parked over
  // empty space where the removed nodes used to be.
  useEffect(() => {
    void fitView(FIT);
  }, [positions, fitView]);

  const counts = useMemo(() => {
    const total: Record<InfraNodeKind, number> = {
      profile: 0,
      bm: 0,
      adAccount: 0,
      pixel: 0,
      page: 0,
    };
    for (const n of graph.nodes) total[n.kind] += 1;
    return total;
  }, [graph.nodes]);

  const atRisk = graph.nodes.filter((n) => n.risk.level !== "safe").length;
  const detail = selected ? visible.nodes.find((n) => n.id === selected) : undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {[
            { on: true, label: `At risk · ${atRisk}` },
            { on: false, label: `Everything · ${graph.nodes.length}` },
          ].map((mode) => (
            <button
              key={mode.label}
              type="button"
              onClick={() => setRiskOnly(mode.on)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                riskOnly === mode.on
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {INFRA_NODE_KINDS.map((kind) => {
            const Icon = KIND[kind].icon;
            const off = hidden.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(kind)) next.add(kind);
                    return next;
                  })
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  off
                    ? "border-border/60 text-muted-foreground/50 line-through"
                    : "border-border bg-card hover:bg-accent/40",
                )}
              >
                <Icon className="size-3" />
                {KIND[kind].label}
                <span className="font-mono tabular-nums text-muted-foreground">{counts[kind]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Outside the canvas on purpose: as a React Flow Panel this sat on top of the nodes it explains. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-0.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <svg width="24" height="6" aria-hidden>
            <line x1="0" y1="3" x2="24" y2="3" stroke="var(--muted-foreground)" strokeWidth="2" />
          </svg>
          live access path
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="24" height="6" aria-hidden>
            <line
              x1="0"
              y1="3"
              x2="24"
              y2="3"
              stroke="var(--destructive)"
              strokeWidth="2"
              strokeDasharray="5 4"
            />
          </svg>
          dead path — the source cannot grant access
        </span>
        {(["critical", "warning", "safe"] as const).map((level) => (
          <span key={level} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", RISK_DOT[level])} />
            {level}
          </span>
        ))}
        <span className="ml-auto">Click a node to isolate its access paths</span>
      </div>

      {detail && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5">
          <span className="text-sm font-semibold">{detail.name}</span>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {KIND[detail.kind].label}
          </span>
          <RiskBadge risk={detail.risk} />
          <span className="text-[11px] text-muted-foreground">{detail.detail}</span>
          <Link
            to={KIND[detail.kind].to}
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            Open registry <ExternalLink className="size-3" />
          </Link>
        </div>
      )}

      <div className="h-[76vh] min-h-[600px] overflow-hidden rounded-xl border border-border bg-background">
        {visible.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {graph.nodes.length === 0
              ? "Nothing registered yet — add a profile or a Business Manager to draw the map."
              : riskOnly
                ? "Every visible asset has at least two independent access paths. Switch to Everything to see the full map."
                : "Every kind is hidden. Re-enable one above."}
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            fitView
            fitViewOptions={FIT}
            minZoom={0.1}
            maxZoom={1.75}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: false }}
            onNodeClick={(_, n) => setSelected((prev) => (prev === n.id ? null : n.id))}
            onPaneClick={() => setSelected(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => RISK_HEX[(n.data as FlowData).node.risk.level]}
              maskColor="rgba(0,0,0,0.6)"
            />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

export function InfraGraphCanvas({ graph }: { graph: InfraGraph }) {
  return (
    <ReactFlowProvider>
      <Canvas graph={graph} />
    </ReactFlowProvider>
  );
}
