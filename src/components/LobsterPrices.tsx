import { useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, CalendarClock, Download, ExternalLink, TriangleAlert } from 'lucide-react';
import { downloadFile } from '../lib/export';
import {
  lobsterMarketHistory,
  marketCsv,
  marketDataStatus,
  marketDate,
  marketPrice,
  type LobsterMarketHistory,
} from '../lib/lobster-market';
import { marketExportToast } from '../lib/toast-copy';
import './lobster-prices.css';

const ranges = [
  { value: 5, label: '5 years' },
  { value: 10, label: '10 years' },
  { value: 25, label: '25 years' },
  { value: 0, label: 'All history' },
];

/** The drawing runs from -12 to 252 units: room above the top line and below the axis. */
const VIEW_TOP = -12;
const VIEW_HEIGHT = 264;
/** Round steps in cents for the price scale. */
const STEPS = [25, 50, 100, 200, 250, 500, 1_000];
/** A finger has to move this far sideways before a touch counts as a scrub, not a tap. */
const DRAG_PX = 8;
/** One minus sign everywhere a fall is written. */
const MINUS = '−';

export function LobsterPrices({
  history = lobsterMarketHistory,
  onNavigate,
  onNotify,
}: {
  history?: LobsterMarketHistory;
  /** Moves the app to another page, e.g. 'places/prices', as its own navigation does. */
  onNavigate?: (target: string) => void;
  /** Confirms something the page did, such as an export, in the app's toast. */
  onNotify?: (message: string) => void;
}) {
  const [range, setRange] = useState(25);
  const [inspectedYear, setInspectedYear] = useState<number>();
  // The slider speaks its own year and price (aria-valuetext). A mouse or a finger on the chart
  // has no such voice, so only those inspections are said here, never a slider step a second time.
  const [spoken, setSpoken] = useState('');
  const chartTitle = useId();
  const sliderId = useId();
  const latest = history.observations.at(-1)!;
  const previous = history.observations.at(-2);
  const rows = history.observations.filter((row) => !range || row.year >= latest.year - range + 1);
  const first = rows[0];
  const selected = rows.find((row) => row.year === inspectedYear) ?? latest;
  const high = history.observations.reduce((best, row) =>
    row.priceCentsPerLb > best.priceCentsPerLb ? row : best,
  );
  const difference = previous ? latest.priceCentsPerLb - previous.priceCentsPerLb : 0;
  const percent = previous ? (difference / previous.priceCentsPerLb) * 100 : 0;
  const sign = (value: number) => (value > 0 ? '+' : value < 0 ? MINUS : '');
  const top = Math.max(...rows.map((row) => row.priceCentsPerLb));
  const step = STEPS.find((item) => Math.ceil(top / item) <= 4) ?? STEPS.at(-1)!;
  const ceiling = Math.max(step, Math.ceil(top / step) * step);
  const ticks = Array.from({ length: ceiling / step + 1 }, (_, index) => ceiling - index * step);
  const span = Math.max(1, latest.year - first.year);
  const x = (year: number) => (900 * (year - first.year)) / span;
  const y = (cents: number) => 240 - (240 * cents) / ceiling;
  /** Where a year or a price sits across, or down, the plot, as a percentage for HTML overlays. */
  const across = (year: number) => `${((year - first.year) / span) * 100}%`;
  const down = (cents: number) => `${((y(cents) - VIEW_TOP) / VIEW_HEIGHT) * 100}%`;
  const pathOf = (list: typeof rows) =>
    list
      .map((row, index) => `${index ? 'L' : 'M'}${x(row.year)},${y(row.priceCentsPerLb)}`)
      .join(' ');
  const path = pathOf(rows);
  // A run of preliminary years at the end is drawn apart from the final ones: the line turns dashed
  // at the last final year and each preliminary point is open, since they may still be revised.
  const pendingFrom = rows.findIndex((_, index) =>
    rows.slice(index).every((row) => row.preliminary),
  );
  const pendingPoints = pendingFrom < 0 ? [] : rows.slice(pendingFrom);
  const solidPath = pathOf(pendingFrom < 0 ? rows : rows.slice(0, Math.max(pendingFrom, 1)));
  // The dashed run starts at the last final point, so the line is not broken between the two.
  const pendingRun = pendingFrom < 0 ? [] : rows.slice(Math.max(pendingFrom - 1, 0));
  const pendingYears =
    pendingPoints.length > 1
      ? `${pendingPoints[0].year} to ${pendingPoints.at(-1)!.year} are`
      : `${pendingPoints[0]?.year} is`;
  const middle = Math.round((first.year + latest.year) / 2);
  const yearTicks = [...new Set([first.year, middle, latest.year])];
  const status = marketDataStatus(history);
  const yearText = (row: typeof latest) =>
    `${row.year}: ${marketPrice(row.priceCentsPerLb)} per pound${row.preliminary ? ', preliminary' : ''}`;

  // A mouse or pen inspects on press and on hover. A finger inspects on a tap or a sideways drag;
  // a vertical swipe stays a page scroll (touch-action: pan-y) and cancels without a change.
  const touch = useRef<{ id: number; x: number; dragging: boolean }>(undefined);
  function inspectAt(event: ReactPointerEvent<HTMLElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    const position = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const year = Math.round(first.year + position * (latest.year - first.year));
    setInspectedYear(year);
    const row = rows.find((item) => item.year === year);
    if (row) setSpoken(yearText(row));
  }
  const pointerHandlers = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType === 'touch') {
        touch.current = { id: event.pointerId, x: event.clientX, dragging: false };
        return;
      }
      if (event.button > 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      inspectAt(event);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType !== 'touch') return inspectAt(event);
      const start = touch.current;
      if (!start || start.id !== event.pointerId) return;
      if (!start.dragging && Math.abs(event.clientX - start.x) < DRAG_PX) return;
      start.dragging = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      inspectAt(event);
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType === 'touch' && touch.current?.id === event.pointerId) inspectAt(event);
      touch.current = undefined;
    },
    onPointerCancel() {
      touch.current = undefined;
    },
  };

  return (
    <div className="market-page">
      <p className={status.state === 'late' ? 'market-data-age late' : 'market-data-age'}>
        <CalendarClock size={14} />
        {status.label}
      </p>
      <div className="market-intro">
        <p>
          <strong>Maine · American lobster</strong>
          <br />
          Annual average paid to harvesters, in nominal USD per live-weight pound. Retail, wholesale
          resale, and picked meat have different prices.
        </p>
      </div>
      {status.state !== 'current' && (
        <p
          className={`market-update-notice${status.state === 'late' ? ' warning' : ''}`}
          role="status"
        >
          {status.state === 'late' ? (
            <TriangleAlert size={16} aria-hidden="true" />
          ) : (
            <CalendarClock size={16} aria-hidden="true" />
          )}
          <span>
            {status.state === 'late'
              ? 'Maine DMR’s annual update is later than expected.'
              : 'The next annual update from Maine DMR is expected soon.'}{' '}
            Showing the latest published figures, through {latest.year}.
          </span>
        </p>
      )}
      <div className="market-summary-grid">
        <section className="panel market-stat">
          <span>Latest published year · {latest.year}</span>
          <strong>
            {marketPrice(latest.priceCentsPerLb)}
            <small>/lb</small>
          </strong>
          <p>{latest.preliminary ? 'Preliminary annual average' : 'Final annual average'}</p>
        </section>
        <section className="panel market-stat">
          <span>Change from {previous?.year ?? latest.year}</span>
          <strong>
            {sign(difference)}
            {marketPrice(Math.abs(difference))}
            <small>/lb</small>
          </strong>
          <p>
            {sign(percent)}
            {Math.abs(percent).toFixed(1)}% year over year
          </p>
        </section>
        <section className="panel market-stat">
          <span>Highest nominal price · {high.year}</span>
          <strong>
            {marketPrice(high.priceCentsPerLb)}
            <small>/lb</small>
          </strong>
          <p>
            In the {history.observations[0].year}–{latest.year} published series
          </p>
        </section>
      </div>

      <section className="panel market-chart-panel">
        <div className="market-chart-header">
          <div>
            <h2>Lobster prices over time</h2>
            <p>
              Annual boat prices · USD/lb · {first.year}–{latest.year}
            </p>
          </div>
          <button
            className="button button-secondary"
            onClick={() => {
              const filename = `lobster-prices-${first.year}-${latest.year}.csv`;
              downloadFile(marketCsv(rows, history), filename, 'text/csv;charset=utf-8');
              onNotify?.(marketExportToast(filename, rows.length));
            }}
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
        <div className="market-range-controls" role="group" aria-label="Price history range">
          {ranges.map((item) => (
            <button
              key={item.value}
              aria-pressed={range === item.value}
              onClick={() => {
                setRange(item.value);
                setInspectedYear(undefined);
                setSpoken('');
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="market-readout">
          <strong>
            {selected.year} <span>{marketPrice(selected.priceCentsPerLb)}/lb</span>
          </strong>
          {selected.preliminary && <span className="market-preliminary">Preliminary</span>}
        </div>
        <p className="sr-only" role="status">
          {spoken}
        </p>
        <div className="market-plot">
          <div className="market-y-axis" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick} style={{ top: down(tick) }}>
                {marketPrice(tick)}
              </span>
            ))}
          </div>
          <div className="market-plot-body">
            <div className="market-plot-area" {...pointerHandlers}>
              <svg
                viewBox={`0 ${VIEW_TOP} 900 ${VIEW_HEIGHT}`}
                preserveAspectRatio="none"
                role="img"
                aria-labelledby={chartTitle}
              >
                <title id={chartTitle}>
                  Annual Maine lobster boat prices from {first.year} to {latest.year}. Selected{' '}
                  {selected.year}: {marketPrice(selected.priceCentsPerLb)} per pound.
                </title>
                <defs>
                  <linearGradient
                    id={`${chartTitle}-fill`}
                    className="market-price-gradient"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopOpacity="0.26" />
                    <stop offset="100%" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <path d={`${path} L900,240 L0,240 Z`} fill={`url(#${chartTitle}-fill)`} />
                {ticks.map((tick) => (
                  <line
                    className="market-grid-line"
                    key={tick}
                    x1="0"
                    x2="900"
                    y1={y(tick)}
                    y2={y(tick)}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <path
                  className="market-price-line"
                  d={solidPath}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
                {pendingRun.length > 1 && (
                  <path
                    className="market-price-line pending"
                    d={pathOf(pendingRun)}
                    fill="none"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                <line
                  className="market-cursor-line"
                  x1={x(selected.year)}
                  x2={x(selected.year)}
                  y1="0"
                  y2="240"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {/* HTML, not SVG: the drawing stretches to the box, which would squash a circle. */}
              {pendingPoints.map((row) => (
                <span
                  key={row.year}
                  className="market-point-pending"
                  aria-hidden="true"
                  style={{ left: across(row.year), top: down(row.priceCentsPerLb) }}
                />
              ))}
              <span
                className={`market-marker${selected.preliminary ? ' preliminary' : ''}`}
                aria-hidden="true"
                style={{ left: across(selected.year), top: down(selected.priceCentsPerLb) }}
              />
            </div>
            <div className="market-x-axis" aria-hidden="true">
              {yearTicks.map((year) => (
                <span
                  key={year}
                  className={year === first.year ? 'start' : year === latest.year ? 'end' : ''}
                  style={{ left: across(year) }}
                >
                  {year}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="market-year-control">
          <label htmlFor={sliderId}>Inspect year</label>
          <span className="market-year-value" aria-hidden="true">
            {selected.year}
          </span>
          <input
            id={sliderId}
            type="range"
            min={first.year}
            max={latest.year}
            value={selected.year}
            step="1"
            aria-valuetext={yearText(selected)}
            onChange={(event) => {
              setInspectedYear(Number(event.target.value));
              // The slider now speaks this year itself; an older pointer inspection must not linger.
              setSpoken('');
            }}
          />
        </div>
        <p className="market-chart-caption">
          Each point is one calendar year.
          {pendingPoints.length > 0 &&
            ` ${pendingYears} preliminary, drawn dashed with an open point, and may be revised.`}
        </p>
      </section>

      <details className="panel market-table-panel">
        <summary>
          View annual data <span>{rows.length} years</span>
        </summary>
        <div
          className="market-table-scroll"
          role="region"
          aria-label="Annual lobster prices table"
          tabIndex={0}
        >
          <table>
            <caption className="sr-only">
              Published annual lobster prices, {first.year} to {latest.year}
            </caption>
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">Price / lb</th>
                <th scope="col">Landings</th>
                <th scope="col">Landed value</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .slice()
                .reverse()
                .map((row) => (
                  <tr key={row.year}>
                    <th scope="row">
                      {row.year}
                      {/* On phones the Status column folds in here, under the year. */}
                      <span className="market-year-status">
                        {row.preliminary ? 'Preliminary' : 'Final'}
                      </span>
                    </th>
                    <td>{marketPrice(row.priceCentsPerLb)}</td>
                    <td>{(row.pounds / 1_000_000).toFixed(2)}M lb</td>
                    <td>${(row.landedValueUsd / 1_000_000).toFixed(2)}M</td>
                    <td>{row.preliminary ? 'Preliminary' : 'Final'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
      <section className="panel market-source-panel">
        <div>
          <h2>From Maine’s official landings records</h2>
          <p>
            Source published {marketDate(history.sourceUpdatedOn)} ·{' '}
            {history.checkMethod === 'manual-file'
              ? 'Source file checked by hand'
              : 'Automatic source check last succeeded'}{' '}
            {marketDate(history.checkedAt)} (UTC).
            {/* A file checked by hand means the weekly automatic check is not getting through. */}
            {history.checkMethod !== 'manual-file' &&
              ' New publications and revisions are checked weekly.'}
          </p>
        </div>
        <ul>
          {history.notes.slice(1).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <div className="market-source-links">
          <a href={history.sourceUrl} target="_blank" rel="noreferrer">
            Source table (PDF)
            <span className="sr-only"> (opens in a new tab)</span>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
          <a href={history.sourcePageUrl} target="_blank" rel="noreferrer">
            Maine DMR
            <span className="sr-only"> (opens in a new tab)</span>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
          <a
            href="#places/prices"
            onClick={(event) => {
              if (!onNavigate) return;
              event.preventDefault();
              onNavigate('places/prices');
            }}
          >
            Restaurant roll prices
            <ArrowUpRight size={14} />
          </a>
        </div>
      </section>
    </div>
  );
}
