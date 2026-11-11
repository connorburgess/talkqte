import { useLayoutEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import './panels.css';

export function useElementWidth() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

export const boundWidth = (value: number, min: number, max: number) =>
  Math.round(Math.min(Math.max(min, max), Math.max(min, value)));

type Props = {
  label: string;
  controls: string;
  className: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

export function PanelDivider({
  label,
  controls,
  className,
  value,
  min,
  max,
  onChange,
}: Props) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const change = (next: number) => onChange(boundWidth(next, min, max));
  return (
    <div
      className={`panel-divider ${className}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels wide`}
      aria-describedby="panel-resize-help"
      title={`Resize ${label.toLowerCase()}. Use left and right arrow keys, or Panel sizes above.`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, width: value };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.id === event.pointerId)
          change(start.width + event.clientX - start.x);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        change(drag.current.width);
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault();
          const start = drag.current;
          drag.current = null;
          setDragging(false);
          change(start.width);
          event.currentTarget.releasePointerCapture(start.id);
          return;
        }
        const step = event.shiftKey ? 40 : 16;
        const next = {
          ArrowLeft: value - step,
          ArrowRight: value + step,
          Home: min,
          End: max,
        }[event.key];
        if (next !== undefined) {
          event.preventDefault();
          change(next);
        }
      }}
    >
      <GripVertical size={16} aria-hidden="true" />
    </div>
  );
}
