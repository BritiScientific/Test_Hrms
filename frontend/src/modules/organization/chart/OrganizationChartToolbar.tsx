import type { ReactNode } from 'react';
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, ChevronUp, LocateFixed, Maximize, ZoomIn, ZoomOut,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { MAX_SCALE, MIN_SCALE } from './chart-layout';

function Tool({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button variant="outline" size="icon" className="size-9 pointer-coarse:size-10" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

export function OrganizationChartToolbar({ scale, onZoomIn, onZoomOut, onFit, onReset, onExpandAll, onCollapseAll, onPan }: {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onReset: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onPan: (dx: number, dy: number) => void;
}) {
  const step = 120;
  return (
    // Above the canvas on small screens, where floating over it would cover the top card.
    <div className="shrink-0 border-b border-line bg-surface p-1 md:pointer-events-none md:absolute md:right-3 md:top-3 md:z-10 md:flex md:flex-col md:items-end md:gap-2 md:border-0 md:bg-transparent md:p-0">
      <div role="toolbar" aria-label="Chart controls" className="pointer-events-auto flex flex-wrap justify-center gap-1 md:justify-end md:rounded-xl md:border md:border-line md:bg-surface/95 md:p-1 md:shadow-card">
        <Tool label="Zoom in" onClick={onZoomIn} disabled={scale >= MAX_SCALE}><ZoomIn className="size-4" aria-hidden /></Tool>
        <span className="flex w-11 items-center justify-center text-xs font-medium text-muted tabular" aria-live="polite" aria-label={`Zoom ${Math.round(scale * 100)} percent`}>
          {Math.round(scale * 100)}%
        </span>
        <Tool label="Zoom out" onClick={onZoomOut} disabled={scale <= MIN_SCALE}><ZoomOut className="size-4" aria-hidden /></Tool>
        <Tool label="Fit to screen" onClick={onFit}><Maximize className="size-4" aria-hidden /></Tool>
        <Tool label="Reset position" onClick={onReset}><LocateFixed className="size-4" aria-hidden /></Tool>
        <Tool label="Expand all" onClick={onExpandAll}><ChevronsUpDown className="size-4" aria-hidden /></Tool>
        <Tool label="Collapse all" onClick={onCollapseAll}><ChevronsDownUp className="size-4" aria-hidden /></Tool>
      </div>
      {/* Touch screens pan by dragging; this is for mouse and keyboard users who prefer buttons. */}
      <div className="pointer-events-auto hidden grid-cols-3 gap-0.5 rounded-xl border border-line bg-surface/95 p-1 shadow-card md:grid">
        <span />
        <Tool label="Move up" onClick={() => onPan(0, step)}><ChevronUp className="size-4" aria-hidden /></Tool>
        <span />
        <Tool label="Move left" onClick={() => onPan(step, 0)}><ChevronLeft className="size-4" aria-hidden /></Tool>
        <span />
        <Tool label="Move right" onClick={() => onPan(-step, 0)}><ChevronRight className="size-4" aria-hidden /></Tool>
        <span />
        <Tool label="Move down" onClick={() => onPan(0, -step)}><ChevronDown className="size-4" aria-hidden /></Tool>
        <span />
      </div>
    </div>
  );
}
