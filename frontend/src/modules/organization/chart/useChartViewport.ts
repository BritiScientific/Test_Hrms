import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { zoomAt, type Size, type Transform } from './chart-layout';

const DRAG_THRESHOLD = 4;
const STEP = 80;
export const ZOOM_STEP = 1.2;
/** Used until the element can be measured (and in test environments, which have no layout). */
const FALLBACK: Size = { w: 1024, h: 600 };

function measureElement(el: HTMLElement | null): Size {
  return { w: el?.clientWidth || FALLBACK.w, h: el?.clientHeight || FALLBACK.h };
}

/**
 * Pan and zoom for the chart canvas: drag (mouse or one finger), pinch, Ctrl/⌘ +
 * wheel or trackpad pinch, and arrow / + / − keys. A plain wheel is left alone so
 * the page keeps scrolling normally when the pointer is over the chart.
 */
export function useChartViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>(FALLBACK);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    const el = ref.current;
    const update = () => setSize(measureElement(el));
    update();
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pan = useCallback((dx: number, dy: number) => setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy })), []);

  const zoom = useCallback((factor: number, px = sizeRef.current.w / 2, py = sizeRef.current.h / 2) => {
    setTransform((t) => zoomAt(t, factor, px, py));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - box.left, e.clientY - box.top);
    };
    // React's onWheel is passive, which cannot stop the browser's own page zoom.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ dragged: false, startX: 0, startY: 0, pinch: 0 });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { dragged: false, startX: e.clientX, startY: e.clientY, pinch: 0 };
    else gesture.current.pinch = 0;
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const box = e.currentTarget.getBoundingClientRect();
      if (gesture.current.pinch) {
        zoom(distance / gesture.current.pinch, (a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top);
      }
      gesture.current.pinch = distance;
      gesture.current.dragged = true;
      return;
    }
    if (!gesture.current.dragged) {
      if (Math.hypot(e.clientX - gesture.current.startX, e.clientY - gesture.current.startY) < DRAG_THRESHOLD) return;
      gesture.current.dragged = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    pan(e.clientX - prev.x, e.clientY - prev.y);
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
  };

  // The click that ends a drag must not open the card it happened to end on.
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (gesture.current.dragged) {
      e.preventDefault();
      e.stopPropagation();
      gesture.current.dragged = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const action: Record<string, () => void> = {
      ArrowUp: () => pan(0, STEP),
      ArrowDown: () => pan(0, -STEP),
      ArrowLeft: () => pan(STEP, 0),
      ArrowRight: () => pan(-STEP, 0),
      '+': () => zoom(ZOOM_STEP),
      '=': () => zoom(ZOOM_STEP),
      '-': () => zoom(1 / ZOOM_STEP),
    };
    const run = action[e.key];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  return {
    ref, size, sizeRef, transform, setTransform, pan, zoom,
    handlers: {
      onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onPointerLeave: onPointerEnd,
      onClickCapture, onKeyDown,
    },
  };
}
