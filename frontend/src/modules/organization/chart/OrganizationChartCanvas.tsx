import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type FocusEvent } from 'react';
import type { OrgChartNode } from '@/types/api';
import {
  centreOn, fitTransform, isOffScreen, layoutForest, visibleCards, WINDOW_FROM, type PlacedCard, type Size,
} from './chart-layout';
import { EmployeeChartCard } from './EmployeeChartCard';
import { OrganizationChartToolbar } from './OrganizationChartToolbar';
import { useChartViewport, ZOOM_STEP } from './useChartViewport';

/** Below this, fitting everything would be unreadable; open at a readable size on the top card instead. */
const MIN_READABLE_FIT = 0.55;
const START_SCALE = 0.85;

export interface FocusRequest { id: number; seq: number }

export function OrganizationChartCanvas({
  roots, expanded, onToggle, onSelect, onExpandAll, onCollapseAll, matchIds, activeMatchId, focusRequest, viewKey,
}: {
  roots: OrgChartNode[];
  expanded: ReadonlySet<number>;
  onToggle: (id: number) => void;
  onSelect: (id: number) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  matchIds: ReadonlySet<number>;
  activeMatchId: number | null;
  /** Bring this employee into view (search result, “show on chart”). */
  focusRequest: FocusRequest | null;
  /** Changes when a different view of the data is loaded, which re-frames the chart. */
  viewKey: string;
}) {
  const layout = useMemo(() => layoutForest(roots, expanded), [roots, expanded]);
  const cardById = useMemo(() => new Map(layout.cards.map((c) => [c.node.id, c])), [layout]);
  const { ref, size, sizeRef, transform, setTransform, pan, zoom, handlers } = useChartViewport();

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const fit = useCallback(() => setTransform(fitTransform(layoutRef.current, sizeRef.current)), [setTransform, sizeRef]);
  const reset = useCallback(() => {
    const first = layoutRef.current.cards[0];
    if (first) setTransform(centreOn(first, 1, sizeRef.current, true));
  }, [setTransform, sizeRef]);

  const openingView = useCallback((viewport: Size) => {
    const fitted = fitTransform(layoutRef.current, viewport);
    const first = layoutRef.current.cards[0];
    return fitted.scale >= MIN_READABLE_FIT || !first ? fitted : centreOn(first, START_SCALE, viewport, true);
  }, []);

  // Frame the chart when a new view loads, and follow size changes (rotating a
  // phone, the first real measurement) until the user has taken over.
  const userInteracted = useRef(false);
  const framed = useRef<{ key: string; size: Size } | null>(null);
  useLayoutEffect(() => {
    const newView = framed.current?.key !== viewKey;
    const resized = framed.current?.size.w !== size.w || framed.current?.size.h !== size.h;
    if (!newView && (!resized || userInteracted.current)) return;
    framed.current = { key: viewKey, size };
    userInteracted.current = false;
    setTransform(openingView(size));
  }, [viewKey, size, openingView, setTransform]);

  // Expanding must not make the card you clicked jump: re-layout re-centres parents.
  const anchor = useRef<{ id: number; x: number; y: number } | null>(null);
  const toggle = useCallback((id: number) => {
    const card = layoutRef.current.cards.find((c) => c.node.id === id);
    anchor.current = card ? { id, x: card.x, y: card.y } : null;
    onToggle(id);
  }, [onToggle]);

  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    const card = cardById.get(a.id);
    if (!card) return;
    setTransform((t) => ({ ...t, x: t.x - (card.x - a.x) * t.scale, y: t.y - (card.y - a.y) * t.scale }));
  }, [cardById, setTransform]);

  // Runs when the requested card exists, which may be only after its branch has expanded.
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest.seq) return;
    const card = cardById.get(focusRequest.id);
    if (!card) return;
    handledFocus.current = focusRequest.seq;
    userInteracted.current = true;
    setTransform((t) => centreOn(card, Math.max(t.scale, START_SCALE), sizeRef.current));
  }, [focusRequest, cardById, setTransform, sizeRef]);

  // Tabbing to a card outside the viewport brings it into view. Keyboard only: moving
  // the chart under a mouse press would make the click land on something else.
  const onFocusCapture = (e: FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.matches(':focus-visible')) return;
    const id = Number(target.closest('[data-node-id]')?.getAttribute('data-node-id'));
    const card = cardById.get(id);
    if (card && isOffScreen(card, transform, size)) setTransform((t) => centreOn(card, t.scale, size));
  };

  const windowed = layout.cards.length > WINDOW_FROM;
  const shown: PlacedCard[] = windowed ? visibleCards(layout.cards, transform, size) : layout.cards;

  return (
    <div
      className="relative flex h-[68dvh] min-h-[26rem] flex-col overflow-hidden rounded-card border border-line bg-canvas"
      onPointerDownCapture={() => { userInteracted.current = true; }}
      onKeyDownCapture={() => { userInteracted.current = true; }}
    >
      <OrganizationChartToolbar
        scale={transform.scale}
        onZoomIn={() => zoom(ZOOM_STEP)}
        onZoomOut={() => zoom(1 / ZOOM_STEP)}
        onFit={fit}
        onReset={reset}
        onExpandAll={onExpandAll}
        onCollapseAll={onCollapseAll}
        onPan={pan}
      />
      <div
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label="Organization chart. Drag or use the arrow keys to move; plus and minus keys to zoom."
        data-testid="chart-viewport"
        onFocusCapture={onFocusCapture}
        {...handlers}
        // overflow-clip: unlike hidden, it can't be scrolled by focus moving to an off-screen card.
        className="min-h-0 w-full flex-1 cursor-grab touch-none overflow-clip bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] bg-[size:20px_20px] select-none outline-none active:cursor-grabbing focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      >
        <div
          data-testid="chart-content"
          className="relative origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        >
          <svg width={layout.width} height={layout.height} className="pointer-events-none absolute inset-0 text-slate-300" aria-hidden>
            <path d={layout.connectors} data-testid="chart-connectors" fill="none" stroke="currentColor" strokeWidth={1.5} />
          </svg>
          {shown.map((c) => (
            <EmployeeChartCard
              key={c.node.id}
              node={c.node}
              x={c.x}
              y={c.y}
              isRoot={c.isRoot}
              expanded={expanded.has(c.node.id)}
              highlight={activeMatchId === c.node.id ? 'active' : matchIds.has(c.node.id) ? 'match' : 'none'}
              onSelect={onSelect}
              onToggle={toggle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
