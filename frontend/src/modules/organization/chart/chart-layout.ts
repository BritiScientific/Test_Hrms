import type { OrgChartNode, OrganizationChart } from '@/types/api';

/**
 * Pure geometry and tree helpers for the organization chart. Cards have a fixed
 * size, so positions and connector lines can be computed without measuring the
 * DOM, which is what keeps large charts cheap to lay out and easy to test.
 */

export const CARD_W = 248;
export const CARD_H = 136;
const H_GAP = 28;
const V_GAP = 60;
const ROOT_GAP = 72;
const PADDING = 40;
/** From this many childless reports, use a grid under the manager instead of one very wide row. */
const GRID_FROM = 6;

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 2;
/** Above this many cards, only those near the viewport are mounted. */
export const WINDOW_FROM = 150;
/** Above this many people, the chart opens collapsed to the first levels. */
const EXPAND_ALL_UP_TO = 40;

export interface Size { w: number; h: number }
export interface Transform { x: number; y: number; scale: number }
export interface PlacedCard { node: OrgChartNode; x: number; y: number; isRoot: boolean }
export interface ChartLayout { cards: PlacedCard[]; connectors: string; width: number; height: number }

interface Box { node: OrgChartNode; width: number; height: number; kids: Box[]; columns: number }

function gridColumns(count: number) {
  return count <= 12 ? 2 : count <= 40 ? 4 : 6;
}

function measure(node: OrgChartNode, expanded: ReadonlySet<number>): Box {
  const open = expanded.has(node.id) ? node.children : [];
  const kids = open.map((c) => measure(c, expanded));
  if (!kids.length) return { node, width: CARD_W, height: CARD_H, kids, columns: 0 };

  if (kids.length >= GRID_FROM && kids.every((k) => k.kids.length === 0)) {
    const columns = gridColumns(kids.length);
    const rows = Math.ceil(kids.length / columns);
    return {
      node, kids, columns,
      width: columns * CARD_W + (columns - 1) * H_GAP,
      height: CARD_H + V_GAP + rows * CARD_H + (rows - 1) * V_GAP,
    };
  }
  const rowWidth = kids.reduce((sum, k) => sum + k.width, 0) + (kids.length - 1) * H_GAP;
  return {
    node, kids, columns: 0,
    width: Math.max(CARD_W, rowWidth),
    height: CARD_H + V_GAP + Math.max(...kids.map((k) => k.height)),
  };
}

function place(box: Box, left: number, top: number, isRoot: boolean, out: PlacedCard[], lines: string[]) {
  const cx = left + box.width / 2;
  const bottom = top + CARD_H;
  out.push({ node: box.node, x: cx - CARD_W / 2, y: top, isRoot });
  if (!box.kids.length) return;

  const firstRowTop = bottom + V_GAP;
  if (box.columns) {
    // Even column counts leave a gap down the middle for the trunk line.
    const rows = Math.ceil(box.kids.length / box.columns);
    const lastBar = firstRowTop + (rows - 1) * (CARD_H + V_GAP) - V_GAP / 2;
    lines.push(`M${cx} ${bottom}V${lastBar}`);
    for (let r = 0; r < rows; r++) {
      const rowTop = firstRowTop + r * (CARD_H + V_GAP);
      const bar = rowTop - V_GAP / 2;
      const row = box.kids.slice(r * box.columns, (r + 1) * box.columns);
      const centres = row.map((_, i) => left + i * (CARD_W + H_GAP) + CARD_W / 2);
      lines.push(`M${Math.min(cx, centres[0])} ${bar}H${Math.max(cx, centres[centres.length - 1])}`);
      row.forEach((k, i) => {
        lines.push(`M${centres[i]} ${bar}V${rowTop}`);
        place(k, left + i * (CARD_W + H_GAP), rowTop, false, out, lines);
      });
    }
    return;
  }

  const rowWidth = box.kids.reduce((sum, k) => sum + k.width, 0) + (box.kids.length - 1) * H_GAP;
  const bar = bottom + V_GAP / 2;
  let x = left + (box.width - rowWidth) / 2;
  const centres: number[] = [];
  for (const k of box.kids) {
    centres.push(x + k.width / 2);
    place(k, x, firstRowTop, false, out, lines);
    x += k.width + H_GAP;
  }
  lines.push(`M${cx} ${bottom}V${bar}`, `M${centres[0]} ${bar}H${centres[centres.length - 1]}`);
  for (const c of centres) lines.push(`M${c} ${bar}V${firstRowTop}`);
}

/** Positions for the cards that are currently visible (collapsed branches take no work). */
export function layoutForest(roots: OrgChartNode[], expanded: ReadonlySet<number>): ChartLayout {
  const cards: PlacedCard[] = [];
  const lines: string[] = [];
  let x = PADDING;
  let height = 0;
  for (const root of roots) {
    const box = measure(root, expanded);
    place(box, x, PADDING, true, cards, lines);
    x += box.width + ROOT_GAP;
    height = Math.max(height, box.height);
  }
  return {
    cards,
    connectors: lines.join(''),
    width: roots.length ? x - ROOT_GAP + PADDING : 0,
    height: roots.length ? height + 2 * PADDING : 0,
  };
}

export function visibleCards(cards: PlacedCard[], t: Transform, viewport: Size, margin = 300): PlacedCard[] {
  const left = (-t.x - margin) / t.scale;
  const top = (-t.y - margin) / t.scale;
  const right = (viewport.w - t.x + margin) / t.scale;
  const bottom = (viewport.h - t.y + margin) / t.scale;
  return cards.filter((c) => c.x + CARD_W >= left && c.x <= right && c.y + CARD_H >= top && c.y <= bottom);
}

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Everything on screen, centred, never enlarged beyond 100%. */
export function fitTransform(layout: Pick<ChartLayout, 'width' | 'height'>, viewport: Size): Transform {
  if (!layout.width || !layout.height) return { x: 0, y: 0, scale: 1 };
  const scale = clampScale(Math.min(viewport.w / layout.width, viewport.h / layout.height, 1));
  return {
    scale,
    x: (viewport.w - layout.width * scale) / 2,
    y: (viewport.h - layout.height * scale) / 2,
  };
}

/** Puts a card in the middle of the viewport, or near the top with `top`. */
export function centreOn(card: Pick<PlacedCard, 'x' | 'y'>, scale: number, viewport: Size, top = false): Transform {
  return {
    scale,
    x: viewport.w / 2 - (card.x + CARD_W / 2) * scale,
    y: top ? 24 - card.y * scale : viewport.h / 2 - (card.y + CARD_H / 2) * scale,
  };
}

/** Zoom keeping the point under (px, py) in place. */
export function zoomAt(t: Transform, factor: number, px: number, py: number): Transform {
  const scale = clampScale(t.scale * factor);
  const k = scale / t.scale;
  return { scale, x: px - (px - t.x) * k, y: py - (py - t.y) * k };
}

export function isOffScreen(card: Pick<PlacedCard, 'x' | 'y'>, t: Transform, viewport: Size) {
  const x = card.x * t.scale + t.x;
  const y = card.y * t.scale + t.y;
  return x < 0 || y < 0 || x + CARD_W * t.scale > viewport.w || y + CARD_H * t.scale > viewport.h;
}

// ---------------------------------------------------------------- tree index --

export interface ChartIndex {
  byId: Map<number, OrgChartNode>;
  parentOf: Map<number, number>;
  /** Everyone shown, hierarchy first (top-down), then the unassigned. */
  all: OrgChartNode[];
  managers: OrgChartNode[];
  unassignedIds: Set<number>;
}

export function indexChart(chart: Pick<OrganizationChart, 'roots' | 'unassigned'> | undefined): ChartIndex {
  const index: ChartIndex = { byId: new Map(), parentOf: new Map(), all: [], managers: [], unassignedIds: new Set() };
  if (!chart) return index;
  const queue = [...chart.roots];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    index.byId.set(node.id, node);
    index.all.push(node);
    if (node.children.length) index.managers.push(node);
    for (const c of node.children) {
      index.parentOf.set(c.id, node.id);
      queue.push(c);
    }
  }
  for (const node of chart.unassigned) {
    index.byId.set(node.id, node);
    index.all.push(node);
    index.unassignedIds.add(node.id);
  }
  return index;
}

/** Open the first levels of a big organization; open everything in a small one. */
export function defaultExpanded(chart: Pick<OrganizationChart, 'roots'>, index: ChartIndex): Set<number> {
  const inHierarchy = index.all.length - index.unassignedIds.size;
  if (inHierarchy <= EXPAND_ALL_UP_TO) return new Set(index.managers.map((m) => m.id));
  return new Set(chart.roots.map((r) => r.id));
}

export function ancestorsOf(id: number, index: Pick<ChartIndex, 'parentOf'>): number[] {
  const out: number[] = [];
  for (let cur = index.parentOf.get(id); cur !== undefined; cur = index.parentOf.get(cur)) out.push(cur);
  return out;
}

export function findMatches(index: Pick<ChartIndex, 'all'>, term: string): number[] {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  return index.all
    .filter((n) => [n.fullName, n.employeeCode, n.jobTitle].some((v) => v?.toLowerCase().includes(q)))
    .map((n) => n.id);
}
