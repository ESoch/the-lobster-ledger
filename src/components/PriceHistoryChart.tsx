import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  priceDateLabel,
  priceLabel,
  visitPeriod,
  type PriceSeries,
} from '../lib/price-observations';
import { plural } from '../lib/plural';
import type { PriceObservation } from '../lib/types';

/** Before the box is measured (and where nothing can measure it): the old drawing's width. */
const FALLBACK_WIDTH = 520;
const HEIGHT = 168;
/** Room for the value scale on the left, the dates underneath and a dot's halo at the edges. */
const PAD = { top: 18, right: 14, bottom: 30, left: 44 };
const LABEL = 12;
const DAY = 86_400_000;

/** The middle of the days a visit covers, so a month-only report sits mid-month. */
const visitTime = (report: PriceObservation) => {
  const { start, end } = visitPeriod(report);
  return (Date.parse(`${start}T00:00:00Z`) + Date.parse(`${end}T00:00:00Z`)) / 2 / DAY;
};

/** Steps in cents that read as round prices. */
const STEPS = [25, 50, 100, 200, 250, 500, 1_000, 2_000, 2_500, 5_000, 10_000, 25_000];
/**
 * A value scale of two to five round prices that covers every point. A level series is centred
 * between the step below and the step above, so it never lies on the floor of the plot.
 */
export function priceTicks(values: number[]): number[] {
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (low === high) {
    // About 3% of the price either side: $1 around a $29 roll.
    const step = STEPS.find((item) => item * 30 >= low) ?? STEPS.at(-1)!;
    return [low - step, low, low + step].filter((value) => value >= 0);
  }
  const step = STEPS.find((item) => (high - low) / item <= 4) ?? STEPS.at(-1)!;
  const first = Math.floor(low / step) * step;
  const last = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= last; value += step) ticks.push(value);
  return ticks;
}

/**
 * A restaurant's price for one item over time. The drawing is measured, so its viewBox is the
 * width it is shown at: one unit is one CSS pixel and the 12px labels stay 12px on any screen.
 * Visits are placed by date, so the gaps between points are the gaps between visits.
 *
 * Every point's value shows on hover, on focus and when it is tapped. The chart is one tab stop
 * (the latest visit to begin with) and the arrow keys, Home and End move along its points.
 */
export function PriceHistoryChart({
  series,
  restaurantName,
}: {
  series: Pick<PriceSeries, 'label' | 'reports' | 'visitReports'>;
  restaurantName: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const id = useId();
  // The point the tab key lands on, and the one whose value is showing from a tap or focus.
  const [tabStopId, setTabStopId] = useState<string>();
  const [shownId, setShownId] = useState<string>();
  const pointElements = useRef(new Map<string, SVGGElement>());
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = (value: number) => value > 0 && setWidth(Math.round(value));
    measure(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // One point per visit, the same visits the change and the one-visit note count: a month report
  // with a day inside it is that day, so no two points share a date or invent a change.
  const points = series.visitReports;
  const ticks = priceTicks(points.map((point) => point.priceCents));
  const [floor, ceiling] = [ticks[0], ticks.at(-1)!];
  const times = points.map(visitTime);
  const [start, end] = [Math.min(...times), Math.max(...times)];
  const left = PAD.left;
  const right = Math.max(left + 1, width - PAD.right);
  const x = (time: number) =>
    Math.round((left + ((time - start) / Math.max(1, end - start)) * (right - left)) * 10) / 10;
  const y = (cents: number) =>
    Math.round(
      (HEIGHT -
        PAD.bottom -
        ((cents - floor) / Math.max(1, ceiling - floor)) * (HEIGHT - PAD.top - PAD.bottom)) *
        10,
    ) / 10;
  const placed = points.map((point, index) => ({
    point,
    x: x(times[index]),
    y: y(point.priceCents),
  }));
  const flat = new Set(points.map((point) => point.priceCents)).size === 1;
  const whole = ticks.every((tick) => tick % 100 === 0);
  const tickLabel = (cents: number) => (whole ? `$${cents / 100}` : priceLabel(cents));
  const [first, last] = [placed[0], placed.at(-1)!];
  const tabStop = placed.find((item) => item.point.id === tabStopId) ?? last;

  // A tap outside the points puts a tapped value away; a touch screen may never move focus.
  useEffect(() => {
    if (!shownId) return;
    const away = (event: Event) => {
      if (!(event.target as Element | null)?.closest?.('.price-point')) setShownId(undefined);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [shownId]);

  function walk(event: React.KeyboardEvent, from: number) {
    const to = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: 0, End: placed.length - 1 }[
      event.key
    ];
    if (to === undefined) return;
    event.preventDefault();
    const next = placed[Math.min(Math.max(to, 0), placed.length - 1)];
    pointElements.current.get(next.point.id)?.focus();
  }

  return (
    <div className="price-chart-frame" ref={frame}>
      <svg
        className="price-chart"
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="group"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
      >
        <title id={`${id}-title`}>
          {series.label} at {restaurantName}
        </title>
        <desc id={`${id}-desc`}>
          {points
            .map((point) => `${priceDateLabel(point)}: ${priceLabel(point.priceCents)}.`)
            .join(' ')}
        </desc>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="price-chart-grid" x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
            <text
              className="price-chart-tick"
              x={left - 8}
              y={y(tick)}
              fontSize={LABEL}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {tickLabel(tick)}
            </text>
          </g>
        ))}
        <path
          className="price-chart-line"
          d={placed.map((item, index) => `${index ? 'L' : 'M'}${item.x},${item.y}`).join(' ')}
        />
        {placed.map((item, index) => (
          <g
            className="price-point"
            key={item.point.id}
            ref={(element) => {
              if (element) pointElements.current.set(item.point.id, element);
              else pointElements.current.delete(item.point.id);
            }}
            role="img"
            aria-label={`${priceDateLabel(item.point)}: ${priceLabel(item.point.priceCents)}`}
            tabIndex={item === tabStop ? 0 : -1}
            data-shown={shownId === item.point.id ? '' : undefined}
            onFocus={() => {
              setTabStopId(item.point.id);
              setShownId(item.point.id);
            }}
            onBlur={() => setShownId(undefined)}
            onPointerDown={() => setShownId(item.point.id)}
            onKeyDown={(event) => walk(event, index)}
          >
            <title>
              {priceLabel(item.point.priceCents)} · {priceDateLabel(item.point)}
            </title>
            {/* A wider, invisible target, so the value shows without landing on a 4px dot. */}
            <circle className="price-hit" cx={item.x} cy={item.y} r={14} />
            <circle className="price-focus" cx={item.x} cy={item.y} r={9} />
            <circle className="price-dot" cx={item.x} cy={item.y} r={4.5} />
            <text
              className="price-point-value"
              x={Math.min(Math.max(item.x, left + 24), right - 24)}
              y={item.y - 12}
              fontSize={LABEL}
              textAnchor="middle"
            >
              {priceLabel(item.point.priceCents)}
            </text>
          </g>
        ))}
        {[first, last].map((item, index) => (
          <text
            key={item.point.id}
            className="price-chart-date"
            x={item.x}
            y={HEIGHT - 8}
            fontSize={LABEL}
            textAnchor={index ? 'end' : 'start'}
          >
            {priceDateLabel(item.point)}
          </text>
        ))}
      </svg>
      {flat && (
        <p className="price-chart-caption">
          No change across {plural(series.reports.length, 'report')}
        </p>
      )}
    </div>
  );
}
