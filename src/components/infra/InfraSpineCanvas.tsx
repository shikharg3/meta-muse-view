import "@xyflow/react/dist/style.css";
import { useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Building, CreditCard, Crosshair, IdCard, ShieldOff, Star } from "lucide-react";
import { RiskBadge } from "@/components/infra/RiskBadge";
import type { InfraGraphNode } from "@/lib/infra-graph";
import type { InfraSpine, SpineAdmin, SpineEndpoint } from "@/lib/infra-spine";
import type { RiskLevel } from "@/lib/infra-risk";
import { INFRA_STATUS_LABEL } from "@/lib/infra-status";
import { cn } from "@/lib/utils";

/**
 * The access spine: Business Managers as cards, their admin profiles inside them.
 *
 * Containment replaces the majority of the edges. A profile that admins one BM is a row in that BM's
 * card, so "belongs to" is expressed by position rather than by a line the eye has to follow across
 * the canvas. What remains drawn as an edge is exactly what deserves attention: a profile shared
 * between BMs (one ban takes out several), and a BM's reach into an ad account or pixel.
 *
 * Layout is computed here rather than by a graph library. After containment the picture is three
 * fixed lanes, and a solver would only reintroduce the unpredictability this redesign removed.
 */

const CARD_W = 340;
/** Title row plus the "n of m admins usable" line. Measured: chips collide below ~66. */
const CARD_HEADER = 68;
const CHIP_H = 42;
const CHIP_GAP = 6;
const CARD_PAD = 10;
const CARD_GAP = 28;
/** Cards per column before a new one starts. Six keeps a column inside a laptop viewport. */
const COLUMN_CAP = 6;
const COLUMN_GAP = 32;

const SIDE_W = 236;
const SIDE_H = 64;
const SIDE_GAP = 12;

const LANE_SHARED_X = 0;
const LANE_BM_X = LANE_SHARED_X + SIDE_W + 90;

const RISK_RING: Record<RiskLevel, string> = {
  critical: "border-destructive/70",
  warning: "border-warning/60",
  safe: "border-border",
};

const RISK_TINT: Record<RiskLevel, string> = {
  critical: "bg-destructive/[0.07]",
  warning: "bg-warning/[0.06]",
  safe: "bg-card",
};

const RISK_DOT: Record<RiskLevel, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  safe: "bg-success",
};

/** `rows` is 0 for a card whose only admin is shared and therefore drawn outside it. */
const cardHeight = (rows: number) =>
  CARD_HEADER + (rows > 0 ? rows * (CHIP_H + CHIP_GAP) + CARD_PAD : CARD_PAD);

type BmData = {
  bm: InfraGraphNode;
  usableAdmins: number;
  totalAdmins: number;
  /** Anything on this canvas is starred, so unstarred cards recede. */
  anyMain: boolean;
};
type AdminData = { admin: SpineAdmin; anyMain: boolean };
type SideData = { node: InfraGraphNode; caption: string; anyMain: boolean };

type BmNode = Node<BmData, "bmCard">;
type AdminNode = Node<AdminData, "adminChip">;
type SideNode = Node<SideData, "side">;

/**
 * `anyMain` is the whole-canvas flag: once the operator has starred anything, the unstarred cards
 * step back so the starred ones read first. With nothing starred there is nothing to step back from,
 * so every card keeps full contrast rather than the canvas dimming itself for no reason.
 */
function BmCard({ data }: NodeProps<BmNode>) {
  const { bm, usableAdmins, totalAdmins, anyMain } = data;
  const recessed = anyMain && !bm.main;
  return (
    <div
      className={cn(
        "h-full w-full rounded-xl border-2 shadow-sm transition-opacity",
        RISK_RING[bm.risk.level],
        RISK_TINT[bm.risk.level],
        bm.main && "ring-2 ring-primary/50",
        recessed && "opacity-55",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-border" />
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
        <Building className="size-3.5 shrink-0 text-muted-foreground" />
        {bm.main && <Star className="size-3 shrink-0 fill-primary text-primary" />}
        <span className="truncate text-[13px] font-semibold">{bm.name}</span>
        {bm.overdue && (
          <span className="shrink-0 text-[9px] uppercase tracking-wider text-warning">overdue</span>
        )}
        <RiskBadge risk={bm.risk} className="ml-auto shrink-0" />
      </div>
      <div className="px-3 pb-0.5 pt-1.5 text-[10px] text-muted-foreground">
        {INFRA_STATUS_LABEL[bm.status] ?? bm.status} · {usableAdmins} of {totalAdmins} admin
        {totalAdmins === 1 ? "" : "s"} usable
      </div>
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-border" />
    </div>
  );
}

/** An admin profile, drawn inside its BM. No handles: containment is the relationship. */
function AdminChip({ data }: NodeProps<AdminNode>) {
  const { profile, dead } = data.admin;
  const recessed = data.anyMain && !profile.main;
  return (
    <div
      className={cn(
        "flex h-full w-full items-center gap-2 rounded-md border px-2.5 transition-opacity",
        dead ? "border-destructive/50 bg-destructive/[0.06]" : "border-border/70 bg-background/60",
        profile.main && !dead && "border-primary/50 bg-primary/[0.07]",
        recessed && "opacity-60",
      )}
    >
      {profile.main && <Star className="size-2.5 shrink-0 fill-primary text-primary" />}
      {dead ? (
        <ShieldOff className="size-3 shrink-0 text-destructive" />
      ) : (
        <IdCard className="size-3 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0">
        <div className={cn("truncate text-[11px] font-medium", dead && "line-through opacity-70")}>
          {profile.name}
        </div>
        <div className="truncate text-[9px] text-muted-foreground">
          {INFRA_STATUS_LABEL[profile.status] ?? profile.status}
        </div>
      </div>
      <span
        className={cn(
          "ml-auto size-1.5 shrink-0 rounded-full",
          dead ? "bg-destructive" : "bg-success",
        )}
      />
    </div>
  );
}

/** A BM with no admin at all. Rendered as a node so the gap is stated, not merely absent. */
function EmptyAdmin() {
  return (
    <div className="flex h-full w-full items-center gap-2 rounded-md border border-dashed border-destructive/50 px-2.5 text-[11px] text-destructive">
      <ShieldOff className="size-3 shrink-0" />
      No admin profile — no way in
    </div>
  );
}

function SideNodeView({ data }: NodeProps<SideNode>) {
  const { node, caption } = data;
  const Icon = node.kind === "pixel" ? Crosshair : node.kind === "adAccount" ? CreditCard : IdCard;
  const isSource = node.kind === "profile";
  // Assets are never starred, so they only recede when the profile lane has stars to defer to.
  const recessed = data.anyMain && !node.main;
  return (
    <div
      className={cn(
        "h-full w-full rounded-lg border-2 px-3 py-2 transition-opacity",
        RISK_RING[node.risk.level],
        RISK_TINT[node.risk.level],
        node.main && "ring-2 ring-primary/50",
        recessed && isSource && "opacity-55",
      )}
    >
      {!isSource && (
        <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-border" />
      )}
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", RISK_DOT[node.risk.level])} />
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        {node.main && <Star className="size-2.5 shrink-0 fill-primary text-primary" />}
        <span className="truncate text-[12px] font-semibold">{node.name}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {INFRA_STATUS_LABEL[node.status] ?? node.status} · {node.risk.label}
      </div>
      <div className="truncate text-[10px] text-muted-foreground/70">{caption}</div>
      {isSource && (
        <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-border" />
      )}
    </div>
  );
}

const nodeTypes = {
  bmCard: BmCard,
  adminChip: AdminChip,
  emptyAdmin: EmptyAdmin,
  side: SideNodeView,
};

/**
 * Place side-lane nodes as close as possible to the cards they point at, then push down to resolve
 * overlaps. Sorting by the wanted position first is what keeps the edges from crossing each other.
 */
function stackBeside(wanted: { id: string; y: number }[], height: number): Record<string, number> {
  const placed: Record<string, number> = {};
  let floor = Number.NEGATIVE_INFINITY;
  for (const item of [...wanted].sort((a, b) => a.y - b.y)) {
    const y = Math.max(item.y, floor);
    placed[item.id] = y;
    floor = y + height + SIDE_GAP;
  }
  return placed;
}

const FIT = { padding: 0.1, minZoom: 0.4, maxZoom: 1, duration: 250 } as const;

function Canvas({ spine }: { spine: InfraSpine }) {
  const { fitView } = useReactFlow();

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // One flag for the whole canvas: recession only makes sense relative to something starred.
    const anyMain = spine.bms.some(
      (entry) =>
        entry.bm.main ||
        entry.inside.some((a) => a.profile.main) ||
        entry.shared.some((a) => a.profile.main),
    );

    // Which shared profile reaches which card. Needed before layout, because a card that a shared
    // profile points at is placed in the leftmost column so its edge stays short and crosses nothing.
    const sharedTargets = new Map<string, { bmId: string; dead: boolean }[]>();
    for (const entry of spine.bms) {
      for (const admin of entry.shared) {
        const list = sharedTargets.get(admin.profile.id);
        if (list) list.push({ bmId: entry.bm.id, dead: admin.dead });
        else sharedTargets.set(admin.profile.id, [{ bmId: entry.bm.id, dead: admin.dead }]);
      }
    }

    // Cards flow down a column, then across. A single column of ten cards is 1,400px against a 700px
    // viewport, which is the whole reason the first attempt at this screen had to be read at 0.31 zoom.
    // Starred cards lead, then the ones a shared profile points at. Reading order is top-left first,
    // so this is the difference between "my main BMs" being the first thing seen and being hunted for.
    const ordered = [...spine.bms].sort(
      (a, b) =>
        Number(Boolean(b.bm.main)) - Number(Boolean(a.bm.main)) ||
        Number(b.shared.length > 0) - Number(a.shared.length > 0),
    );
    const columns = Math.min(3, Math.max(1, Math.ceil(ordered.length / COLUMN_CAP)));
    const perColumn = Math.ceil(ordered.length / columns);

    const centre = new Map<string, { x: number; y: number }>();
    const columnBottom = new Array<number>(columns).fill(0);
    ordered.forEach((entry, i) => {
      const column = Math.floor(i / perColumn);
      // An empty body is only honest when nothing admins the BM at all; a card whose sole admin is
      // shared has its admin drawn outside, and must not claim there is no way in.
      const bodyRows = entry.inside.length || (entry.shared.length === 0 ? 1 : 0);
      const height = cardHeight(bodyRows);
      const x = LANE_BM_X + column * (CARD_W + COLUMN_GAP);
      const y = columnBottom[column];

      nodes.push({
        id: entry.bm.id,
        type: "bmCard",
        position: { x, y },
        width: CARD_W,
        height,
        draggable: false,
        selectable: false,
        data: {
          bm: entry.bm,
          usableAdmins: entry.usableAdmins,
          totalAdmins: entry.inside.length + entry.shared.length,
          anyMain,
        } satisfies BmData,
      });
      // Children are positioned relative to the parent and MUST follow it in the array.
      if (entry.inside.length === 0 && entry.shared.length === 0) {
        nodes.push({
          id: `${entry.bm.id}::empty`,
          type: "emptyAdmin",
          parentId: entry.bm.id,
          extent: "parent",
          position: { x: CARD_PAD, y: CARD_HEADER },
          width: CARD_W - CARD_PAD * 2,
          height: CHIP_H,
          draggable: false,
          selectable: false,
          data: {},
        });
      }
      entry.inside.forEach((admin, row) => {
        nodes.push({
          id: `${entry.bm.id}::${admin.profile.id}`,
          type: "adminChip",
          parentId: entry.bm.id,
          extent: "parent",
          position: { x: CARD_PAD, y: CARD_HEADER + row * (CHIP_H + CHIP_GAP) },
          width: CARD_W - CARD_PAD * 2,
          height: CHIP_H,
          draggable: false,
          selectable: false,
          data: { admin, anyMain } satisfies AdminData,
        });
      });

      centre.set(entry.bm.id, { x: x + CARD_W / 2, y: y + height / 2 });
      columnBottom[column] = y + height + CARD_GAP;
    });

    // Lane 1: shared profiles, level with the average of the cards they admin.
    const sharedY = stackBeside(
      spine.sharedProfiles.map((p) => ({
        id: p.id,
        y: meanY(sharedTargets.get(p.id)?.map((t) => t.bmId) ?? [], centre) - SIDE_H / 2,
      })),
      SIDE_H,
    );
    for (const profile of spine.sharedProfiles) {
      const targets = sharedTargets.get(profile.id) ?? [];
      nodes.push({
        id: profile.id,
        type: "side",
        position: { x: LANE_SHARED_X, y: sharedY[profile.id] ?? 0 },
        width: SIDE_W,
        height: SIDE_H,
        draggable: false,
        selectable: false,
        data: {
          node: profile,
          caption: `admins ${targets.length} Business Managers`,
          anyMain,
        } satisfies SideData,
      });
      for (const target of targets) {
        edges.push(edge(profile.id, target.bmId, target.dead, "admins"));
      }
    }

    // Lane 3: ad accounts and pixels, to the right of the last card column.
    const endpointX = LANE_BM_X + columns * (CARD_W + COLUMN_GAP) + 60;
    const endpointY = stackBeside(
      spine.endpoints.map((e) => ({
        id: e.node.id,
        y:
          meanY(
            e.from.map((f) => f.bmId),
            centre,
          ) -
          SIDE_H / 2,
      })),
      SIDE_H,
    );
    for (const endpoint of spine.endpoints) {
      nodes.push({
        id: endpoint.node.id,
        type: "side",
        position: { x: endpointX, y: endpointY[endpoint.node.id] ?? 0 },
        width: SIDE_W,
        height: SIDE_H,
        draggable: false,
        selectable: false,
        data: { node: endpoint.node, caption: endpoint.node.detail, anyMain } satisfies SideData,
      });
      for (const from of endpoint.from) {
        edges.push(edge(from.bmId, endpoint.node.id, from.dead, from.relation));
      }
    }

    return { nodes, edges };
  }, [spine]);

  useEffect(() => {
    void fitView(FIT);
  }, [nodes, fitView]);

  if (spine.bms.length === 0) {
    return (
      <div className="flex h-[52vh] min-h-[360px] items-center justify-center rounded-xl border border-border bg-card px-6 text-center text-sm text-muted-foreground">
        No Business Managers registered yet — the access spine is built from them.
      </div>
    );
  }

  return (
    <div className="h-[72vh] min-h-[560px] overflow-hidden rounded-xl border border-border bg-background">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={FIT}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** Vertical centre of the cards an outside node points at, so its edges stay as level as possible. */
const meanY = (bmIds: string[], centres: Map<string, { x: number; y: number }>) =>
  bmIds.reduce((sum, id) => sum + (centres.get(id)?.y ?? 0), 0) / Math.max(1, bmIds.length);

function edge(source: string, target: string, dead: boolean, label: string): Edge {
  const colour = dead ? "var(--destructive)" : "var(--muted-foreground)";
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "smoothstep",
    label,
    labelShowBg: false,
    labelStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
    style: {
      stroke: colour,
      strokeWidth: 1.75,
      strokeDasharray: dead ? "5 4" : undefined,
      opacity: dead ? 0.95 : 0.6,
    },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: colour },
  };
}

export function InfraSpineCanvas({ spine }: { spine: InfraSpine }) {
  return (
    <ReactFlowProvider>
      <Canvas spine={spine} />
    </ReactFlowProvider>
  );
}
