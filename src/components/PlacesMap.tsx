import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Crosshair, ExternalLink, MapPin, X } from 'lucide-react';
import L from 'leaflet';
import type { Bet, Place } from '../lib/types';
import { placeBetCounts, placeCountLabel, plural } from '../lib/place-stats';
import 'leaflet/dist/leaflet.css';
import './places-map.css';

type LatLng = { lat: number; lng: number };

/** Minimum distance between pin centres, in pixels. It is also each pin's hit area. */
export const PIN_SPACING = 44;
/** Fitting places never zooms in further than this. */
export const MAX_FIT_ZOOM = 16;
/** Below this zoom the map center is too vague to pin. */
export const PICK_MIN_ZOOM = 10;
const COMFORT_ZOOM = 13;
const SINGLE_PLACE_ZOOM = 15;
const SELECT_ZOOM = 15;
const MAX_CLUSTER_ZOOM = 18;
const START = { lat: 39, lng: -98, zoom: 3 };
const FALLBACK_SIZE = { x: 640, y: 420 };
const crs = L.CRS.EPSG3857;

interface PlacesMapProps {
  places: Place[];
  bets: Bet[];
  selectedPlaceId?: string;
  /** Change it to show the current selection again (a repeated list click, or "All locations"). */
  revealRequest?: number;
  /** With a reveal of a place, also moves keyboard focus to its pin. */
  focusOnReveal?: boolean;
  onSelectPlace?: (place: Place) => void;
  /** A small preview. Without onPickLocation it is a static picture of the pins. */
  compact?: boolean;
  /** Offered from the empty map when there are no places yet. */
  onAddPlace?: () => void;
  onPickLocation?: (location: LatLng) => void;
  pickedLocation?: LatLng;
  onClearPin?: () => void;
}

interface Pin extends LatLng {
  id: string;
  name: string;
  address: string;
  placed: number;
  label: string;
}

function validCoordinates(place: LatLng) {
  return (
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lng) &&
    Math.abs(place.lat) <= 90 &&
    Math.abs(place.lng) <= 180
  );
}

const project = (point: LatLng, zoom: number) =>
  crs.latLngToPoint(L.latLng(point.lat, point.lng), zoom);
const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The view that shows every point with pins at least PIN_SPACING apart, when they can fit. */
export function fitView(points: LatLng[], size: { x: number; y: number }, maxZoom = MAX_FIT_ZOOM) {
  const valid = points.filter(validCoordinates);
  if (!valid.length) return undefined;
  const base = valid.map((point) => project(point, 0));
  const min = L.point(Math.min(...base.map((p) => p.x)), Math.min(...base.map((p) => p.y)));
  const max = L.point(Math.max(...base.map((p) => p.x)), Math.max(...base.map((p) => p.y)));
  const center = crs.pointToLatLng(min.add(max).divideBy(2), 0);
  const span = max.subtract(min);
  if (span.x === 0 && span.y === 0) return { center, zoom: Math.min(SINGLE_PLACE_ZOOM, maxZoom) };
  const inner = {
    x: Math.max(size.x - 2 * PIN_SPACING, PIN_SPACING),
    y: Math.max(size.y - 2 * PIN_SPACING, PIN_SPACING),
  };
  let fitZoom = maxZoom;
  while (fitZoom > 2 && (span.x * 2 ** fitZoom > inner.x || span.y * 2 ** fitZoom > inner.y))
    fitZoom--;
  // Pins that share a spot never separate; clustering shows them as one group instead.
  let closest = Infinity;
  for (let i = 0; i < base.length; i++)
    for (let j = i + 1; j < base.length; j++) {
      const distance = base[i].distanceTo(base[j]);
      if (distance * 2 ** maxZoom >= PIN_SPACING) closest = Math.min(closest, distance);
    }
  let zoom = Math.min(fitZoom, COMFORT_ZOOM);
  while (zoom < fitZoom && closest * 2 ** zoom < PIN_SPACING) zoom++;
  return { center, zoom };
}

/** Fits the places into the map with readable spacing and returns the chosen zoom. */
export function fitPlaces(map: L.Map, places: LatLng[], animate = false) {
  const size = map.getSize();
  const view = fitView(places, size.x > 0 && size.y > 0 ? size : FALLBACK_SIZE);
  if (!view) return map.getZoom();
  map.setView(view.center, view.zoom, { animate });
  return view.zoom;
}

/** Greedy grouping: each pin joins the first group whose first pin is within PIN_SPACING. */
export function clusterPlaces<T extends LatLng>(items: T[], zoom: number): T[][] {
  const groups: { seed: L.Point; items: T[] }[] = [];
  for (const item of items) {
    const point = project(item, zoom);
    const host = groups.find((group) => group.seed.distanceTo(point) < PIN_SPACING);
    if (host) host.items.push(item);
    else groups.push({ seed: point, items: [item] });
  }
  return groups.map((group) => group.items);
}

/** A small map pin (Lucide's MapPin) that marks a group's count as a count of places. */
function placeGlyph() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [name, value] of Object.entries({
    class: 'places-map-pin-glyph',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(name, value);
  const outline = document.createElementNS(ns, 'path');
  outline.setAttribute(
    'd',
    'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0',
  );
  const dot = document.createElementNS(ns, 'circle');
  for (const [name, value] of Object.entries({ cx: '12', cy: '10', r: '3' }))
    dot.setAttribute(name, value);
  svg.appendChild(outline);
  svg.appendChild(dot);
  return svg;
}

function pinIcon(text: string, { selected = false, cluster = false } = {}) {
  const symbol = document.createElement('span');
  symbol.className = `places-map-pin${selected ? ' is-selected' : ''}${cluster ? ' is-cluster' : ''}`;
  symbol.setAttribute('aria-hidden', 'true');
  // Single pins count bets; a group counts places, so it carries a pin glyph beside the number.
  if (cluster) {
    symbol.appendChild(placeGlyph());
    symbol.appendChild(document.createTextNode(text));
  } else if (text) symbol.textContent = text;
  else
    symbol.appendChild(
      Object.assign(document.createElement('span'), { className: 'places-map-pin-dot' }),
    );
  return L.divIcon({
    html: symbol,
    className: `places-map-marker${cluster ? ' is-cluster' : ''}`,
    iconSize: [PIN_SPACING, PIN_SPACING],
    iconAnchor: [PIN_SPACING / 2, PIN_SPACING / 2],
  });
}

const pickedIcon = () =>
  L.divIcon({
    html: '',
    className: 'places-map-picked-pin',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

function osmLink(text: string, href: string) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  const hint = document.createElement('span');
  hint.className = 'sr-only';
  hint.textContent = ' (opens in a new tab)';
  link.appendChild(hint);
  return link;
}

function placePopup(pin: Pin) {
  const content = document.createElement('div');
  content.className = 'places-map-popup';
  content.tabIndex = -1;
  content.setAttribute('role', 'group');
  for (const part of [
    document.createElement('strong'),
    document.createElement('p'),
    document.createElement('span'),
    osmLink('Open in OpenStreetMap ↗', ''),
  ])
    content.appendChild(part);
  fillPlacePopup(content, pin);
  return content;
}

/**
 * Writes a pin's name, address, counts and link into its popup where they are. The popup's
 * content is never swapped for a new one, so focus inside it stays put and the map does not pan
 * back to it, as Popup.update would.
 */
function fillPlacePopup(content: HTMLElement, pin: Pin) {
  const set = (node: Element | null, text: string) => {
    if (node && node.textContent !== text) node.textContent = text;
  };
  if (content.getAttribute('aria-label') !== pin.name) content.setAttribute('aria-label', pin.name);
  set(content.querySelector(':scope > strong'), pin.name);
  const address = content.querySelector<HTMLElement>(':scope > p');
  set(address, pin.address);
  if (address) address.hidden = !pin.address;
  set(content.querySelector(':scope > span'), pin.label);
  const link = content.querySelector<HTMLAnchorElement>(':scope > a');
  const href = `https://www.openstreetmap.org/?mlat=${pin.lat}&mlon=${pin.lng}#map=17/${pin.lat}/${pin.lng}`;
  if (link && link.getAttribute('href') !== href) link.href = href;
}

function clusterPopup(pins: Pin[], onChoose: (pin: Pin) => void) {
  const content = document.createElement('div');
  content.className = 'places-map-popup places-map-popup--list';
  content.tabIndex = -1;
  content.setAttribute('role', 'group');
  const title = document.createElement('strong');
  title.textContent = `${plural(pins.length, 'place')} at this spot`;
  content.setAttribute('aria-label', title.textContent);
  const list = document.createElement('ul');
  for (const pin of pins) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = pin.name;
    const detail = document.createElement('small');
    detail.textContent = plural(pin.placed, 'bet');
    button.appendChild(detail);
    button.addEventListener('click', (event) => {
      // Choosing swaps the popup content, which detaches this button; keep the
      // click from reaching the map, which would then treat it as a click outside.
      event.stopPropagation();
      onChoose(pin);
    });
    item.appendChild(button);
    list.appendChild(item);
  }
  content.appendChild(title);
  content.appendChild(list);
  return content;
}

type Entry = { marker: L.Marker; pin: Pin };
type Cluster = { marker: L.Marker; pins: Pin[] };

export function PlacesMap({
  places,
  bets,
  selectedPlaceId,
  revealRequest = 0,
  focusOnReveal = false,
  onSelectPlace,
  compact = false,
  onAddPlace,
  onPickLocation,
  pickedLocation,
  onClearPin,
}: PlacesMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const popupRef = useRef<L.Popup | null>(null);
  const tilesRef = useRef<L.TileLayer | null>(null);
  const entriesRef = useRef(new Map<string, Entry>());
  const clustersRef = useRef(new Map<string, Cluster>());
  const popupForRef = useRef<{ id?: string; cluster?: string }>({});
  const pendingFocusRef = useRef<string | undefined>(undefined);
  const fromMapRef = useRef(false);
  const selectedRef = useRef<string | undefined>(undefined);
  const revealRef = useRef(revealRequest);
  const pickedMarkerRef = useRef<L.Marker | null>(null);
  const fittedRef = useRef(false);
  const touchTimerRef = useRef<number | undefined>(undefined);
  const centerButtonRef = useRef<HTMLButtonElement>(null);
  const [view, setViewState] = useState(START);
  const [tileError, setTileError] = useState(false);
  const [touchHint, setTouchHint] = useState(false);
  const [pickRefusal, setPickRefusal] = useState('');
  // The zoom a too-far click started: the move it ends with is not "a new view", so it must not
  // wipe what that click just announced.
  const gateZoomRef = useRef(false);
  const noteId = useId();
  const picking = Boolean(onPickLocation);
  const preview = compact && !picking;
  const markersInteractive = !preview && !picking;
  // The full map keeps its credits in a strip under the canvas: over it, a pin that pans to the
  // bottom edge could sit half beneath the OpenStreetMap link or the attribution. The preview and
  // the picker are small and keep Leaflet's own corner attribution.
  const framed = !compact && !picking;
  const attributionSlotRef = useRef<HTMLDivElement>(null);

  const pins = useMemo<Pin[]>(
    () =>
      places.filter(validCoordinates).map((place) => {
        const counts = placeBetCounts(bets, place.id);
        return {
          id: place.id,
          name: place.name,
          address: place.address,
          lat: place.lat,
          lng: place.lng,
          placed: counts.placed,
          label: placeCountLabel(counts),
        };
      }),
    [places, bets],
  );
  // Ledger refreshes deliver equal data in new objects. Only real changes touch the map.
  const contentKey = JSON.stringify(pins);
  const coordinateKey = pins.map(({ id, lat, lng }) => `${id}:${lat}:${lng}`).join('|');
  const latest = useRef({ pins, places, onSelectPlace, onPickLocation, pickedLocation });
  latest.current = { pins, places, onSelectPlace, onPickLocation, pickedLocation };

  function element(id: string) {
    const entry = entriesRef.current.get(id);
    const map = mapRef.current;
    if (!entry || !map) return null;
    if (map.hasLayer(entry.marker)) return entry.marker.getElement() ?? null;
    for (const cluster of clustersRef.current.values())
      if (cluster.pins.some((pin) => pin.id === id)) return cluster.marker.getElement() ?? null;
    return null;
  }

  function decorate(entry: Entry) {
    const node = entry.marker.getElement();
    if (!node) return;
    const label = `${entry.pin.name}: ${entry.pin.label}`;
    // Reference pins (picker, preview) carry no counts: the picker passes no bets.
    node.title = markersInteractive ? label : entry.pin.name;
    if (markersInteractive) {
      node.setAttribute('aria-label', label);
      node.setAttribute('aria-pressed', String(entry.pin.id === selectedRef.current));
    } else node.setAttribute('aria-hidden', 'true');
  }

  function restyle(id: string | undefined) {
    const entry = id ? entriesRef.current.get(id) : undefined;
    if (!entry) return;
    const selected = entry.pin.id === selectedRef.current;
    entry.marker.setIcon(pinIcon(entry.pin.placed ? String(entry.pin.placed) : '', { selected }));
    entry.marker.setZIndexOffset(selected ? 1000 : 0);
    decorate(entry);
  }

  /** Narrow maps get narrower popups, so the pan padding can keep them off the zoom control. */
  function sizePopup(map: L.Map, popup: L.Popup) {
    const width = map.getSize().x;
    // Room left after the pan padding (16 + 56) and the popup's own margins (44 + 2).
    popup.options.maxWidth = Math.max(120, Math.min(240, width - 118));
    popup.options.minWidth = Math.min(160, popup.options.maxWidth);
  }

  function showPopup(content: HTMLElement, at: L.LatLngExpression, focusInside: boolean) {
    const map = mapRef.current;
    const popup = popupRef.current;
    if (!map || !popup) return;
    sizePopup(map, popup);
    popup.setLatLng(at).setContent(content);
    if (map.hasLayer(popup)) popup.update();
    else popup.openOn(map);
    if (focusInside) content.focus();
  }

  function openPlacePopup(id: string, focusInside: boolean) {
    const entry = entriesRef.current.get(id);
    if (!entry) return;
    showPopup(placePopup(entry.pin), [entry.pin.lat, entry.pin.lng], focusInside);
    popupForRef.current = { id };
  }

  function activatePlace(id: string, focusInside: boolean) {
    const place = latest.current.places.find((item) => item.id === id);
    if (!place) return;
    openPlacePopup(id, focusInside);
    if (latest.current.onSelectPlace && selectedRef.current !== id) {
      fromMapRef.current = true;
      latest.current.onSelectPlace(place);
    }
  }

  function activateCluster(key: string, viaKeyboard: boolean) {
    const map = mapRef.current;
    const cluster = clustersRef.current.get(key);
    if (!map || !cluster) return;
    const size = map.getSize();
    const target = fitView(cluster.pins, size.x && size.y ? size : FALLBACK_SIZE, MAX_CLUSTER_ZOOM);
    if (
      target &&
      target.zoom > map.getZoom() &&
      clusterPlaces(cluster.pins, target.zoom).length > 1
    ) {
      pendingFocusRef.current = viaKeyboard ? cluster.pins[0].id : undefined;
      map.setView(target.center, target.zoom, { animate: !prefersReducedMotion() });
      return;
    }
    showPopup(
      clusterPopup(cluster.pins, (pin) => activatePlace(pin.id, true)),
      cluster.marker.getLatLng(),
      viaKeyboard,
    );
    popupForRef.current = { cluster: key };
  }

  function onKeyActivate(event: L.LeafletKeyboardEvent, activate: () => void) {
    const key = event.originalEvent.key;
    if (key !== 'Enter' && key !== ' ') return;
    event.originalEvent.preventDefault();
    activate();
  }

  /** Groups pins that would overlap at the current zoom and keeps keyboard focus in place. */
  function layout() {
    const map = mapRef.current;
    if (!map) return;
    const active = document.activeElement;
    let focusedId: string | undefined;
    for (const entry of entriesRef.current.values())
      if (entry.marker.getElement() === active) focusedId = entry.pin.id;
    for (const cluster of clustersRef.current.values())
      if (cluster.marker.getElement() === active) focusedId = cluster.pins[0].id;
    const next = new Map<string, Cluster>();
    for (const group of clusterPlaces(
      [...entriesRef.current.values()].map((entry) => entry.pin),
      map.getZoom(),
    )) {
      if (group.length === 1) {
        const entry = entriesRef.current.get(group[0].id)!;
        if (!map.hasLayer(entry.marker)) {
          entry.marker.addTo(map);
          decorate(entry);
        }
        continue;
      }
      for (const pin of group) entriesRef.current.get(pin.id)!.marker.remove();
      const key = group
        .map((pin) => pin.id)
        .sort()
        .join('|');
      const selected = group.some((pin) => pin.id === selectedRef.current);
      const label = `${plural(group.length, 'place')}: ${group.map((pin) => pin.name).join(', ')}`;
      let cluster = clustersRef.current.get(key);
      if (!cluster) {
        const marker = L.marker([group[0].lat, group[0].lng], {
          icon: pinIcon(String(group.length), { cluster: true, selected }),
          interactive: markersInteractive,
          keyboard: markersInteractive,
          riseOnHover: markersInteractive,
        });
        marker.on('click', () => activateCluster(key, false));
        marker.on('keydown', (event) =>
          onKeyActivate(event as L.LeafletKeyboardEvent, () => activateCluster(key, true)),
        );
        cluster = { marker, pins: group };
      } else {
        cluster.pins = group;
        cluster.marker.setLatLng([group[0].lat, group[0].lng]);
        cluster.marker.setIcon(pinIcon(String(group.length), { cluster: true, selected }));
      }
      if (!map.hasLayer(cluster.marker)) cluster.marker.addTo(map);
      cluster.marker.setZIndexOffset(selected ? 1000 : 500);
      const node = cluster.marker.getElement();
      if (node) {
        node.title = label;
        if (markersInteractive) node.setAttribute('aria-label', `${label}. Show them on the map`);
        else node.setAttribute('aria-hidden', 'true');
      }
      next.set(key, cluster);
    }
    for (const [key, cluster] of clustersRef.current) if (!next.has(key)) cluster.marker.remove();
    clustersRef.current = next;
    const wanted = pendingFocusRef.current ?? (active?.isConnected ? undefined : focusedId);
    pendingFocusRef.current = undefined;
    if (wanted) element(wanted)?.focus();
  }

  function pickLocation(location: LatLng) {
    // Whatever was said about getting here is spent once the pin is placed.
    gateZoomRef.current = false;
    setPickRefusal('');
    const coordinates = L.latLng(location.lat, location.lng).wrap();
    latest.current.onPickLocation?.({ lat: coordinates.lat, lng: coordinates.lng });
  }

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const motion = !prefersReducedMotion();
    const coarse =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const interactive = !preview;
    const map = L.map(node, {
      center: [START.lat, START.lng],
      zoom: START.zoom,
      minZoom: 2,
      maxZoom: 19,
      scrollWheelZoom: false,
      zoomControl: false,
      // Cooperative gestures: on touch screens one finger scrolls the page, two move the map.
      dragging: interactive && !coarse,
      touchZoom: interactive,
      doubleClickZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      zoomAnimation: motion,
      fadeAnimation: motion,
      markerZoomAnimation: motion,
    });
    mapRef.current = map;
    if (interactive) L.control.zoom({ position: 'topright' }).addTo(map);
    popupRef.current = L.popup({
      className: 'places-map-popup-shell',
      offset: [0, -12],
      // Stay clear of the zoom control (top right). The popup's tip rests 100px up, so the pin under
      // it sits well off the lower edge, where the pins it pans down would otherwise be cut off.
      autoPanPaddingTopLeft: [16, 16],
      autoPanPaddingBottomRight: [56, 100],
    });
    tilesRef.current = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      maxZoom: 19,
    })
      .on('loading', () => setTileError(false))
      .on('tileerror', () => setTileError(true))
      .addTo(map);
    // Leaflet keeps updating the control wherever it sits, so it is moved, not rebuilt.
    const attribution = map.attributionControl.getContainer();
    if (framed && attribution) attributionSlotRef.current?.appendChild(attribution);
    const syncView = () => {
      const center = map.getCenter().wrap();
      setViewState({ lat: center.lat, lng: center.lng, zoom: map.getZoom() });
      // A new view gets a fresh answer, so a second refused Enter is announced again. The view the
      // too-far click itself zoomed to is the answer being given, and keeps it.
      if (gateZoomRef.current) gateZoomRef.current = false;
      else setPickRefusal('');
    };
    map.on('moveend', syncView);
    map.on('zoomend', layout);
    map.on('click', (event: L.LeafletMouseEvent) => {
      if (!latest.current.onPickLocation) return;
      if (map.getZoom() >= PICK_MIN_ZOOM) return pickLocation(event.latlng);
      // At this scale a pin could be hundreds of kilometres from the place meant, and the keyboard
      // and the map center refuse it too. Go to the spot instead, and let the next click pin it.
      // The move ends before this returns without animation and some time after it with, so the
      // flag is set first and the end of the move, whenever it comes, finds it.
      gateZoomRef.current = true;
      map.setView(event.latlng, PICK_MIN_ZOOM, { animate: !prefersReducedMotion() });
      setPickRefusal('Zoomed in on that area. Select the exact spot.');
    });
    map.on('popupclose', () => {
      const { id, cluster } = popupForRef.current;
      popupForRef.current = {};
      // Focus that was inside the popup (or fell to <body> with it) goes back to its pin.
      const active = document.activeElement;
      const lost =
        !active ||
        active === document.body ||
        Boolean(popupRef.current?.getElement()?.contains(active));
      if (!lost) return;
      const target = id
        ? element(id)
        : cluster
          ? clustersRef.current.get(cluster)?.marker.getElement()
          : null;
      target?.focus();
    });
    syncView();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === node && event.key === 'Enter' && latest.current.onPickLocation) {
        event.preventDefault();
        if (map.getZoom() >= PICK_MIN_ZOOM) pickLocation(map.getCenter());
        else setPickRefusal('Zoom in to the place first, then press Enter.');
      }
    };
    node.addEventListener('keydown', onKeyDown);
    // Escape closes the popup before any surrounding dialog sees it.
    const onEscape = (event: KeyboardEvent) => {
      const popup = popupRef.current;
      if (event.key !== 'Escape' || !popup || !map.hasLayer(popup)) return;
      if (!node.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      map.closePopup(popup);
    };
    window.addEventListener('keydown', onEscape, true);
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || map.dragging.enabled() || preview) return;
      setTouchHint(true);
      window.clearTimeout(touchTimerRef.current);
      touchTimerRef.current = window.setTimeout(() => setTouchHint(false), 1600);
    };
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => map.invalidateSize({ pan: false }))
        : undefined;
    observer?.observe(node);
    const entries = entriesRef.current;
    return () => {
      observer?.disconnect();
      node.removeEventListener('keydown', onKeyDown);
      node.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onEscape, true);
      window.clearTimeout(touchTimerRef.current);
      entries.clear();
      clustersRef.current = new Map();
      popupForRef.current = {};
      pickedMarkerRef.current = null;
      fittedRef.current = false;
      map.remove();
      mapRef.current = null;
      popupRef.current = null;
      tilesRef.current = null;
    };
    // The map is created once; mode props are fixed for a mounted map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { pins: current, pickedLocation: pin, onPickLocation: pick } = latest.current;
    if (pick && fittedRef.current) return; // keep the view while someone refines a pin
    fittedRef.current = true;
    if (pick && pin) map.setView([pin.lat, pin.lng], SINGLE_PLACE_ZOOM, { animate: false });
    else fitPlaces(map, current);
    // Only geographical changes reset the viewport.
  }, [coordinateKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const entries = entriesRef.current;
    // The pin an open popup was written for, to tell whether this change is about it at all.
    const { id: openId } = popupForRef.current;
    const shown = openId ? entries.get(openId)?.pin : undefined;
    const next = new Map(pins.map((pin) => [pin.id, pin]));
    for (const [id, entry] of entries)
      if (!next.has(id)) {
        entry.marker.remove();
        entries.delete(id);
      }
    for (const pin of pins) {
      const entry = entries.get(pin.id);
      if (entry) {
        const moved = entry.pin.lat !== pin.lat || entry.pin.lng !== pin.lng;
        const changed = JSON.stringify(entry.pin) !== JSON.stringify(pin);
        entry.pin = pin;
        if (moved) entry.marker.setLatLng([pin.lat, pin.lng]);
        if (changed) restyle(pin.id);
        continue;
      }
      const selected = pin.id === selectedRef.current;
      const marker = L.marker([pin.lat, pin.lng], {
        icon: pinIcon(pin.placed ? String(pin.placed) : '', { selected }),
        title: markersInteractive ? `${pin.name}: ${pin.label}` : pin.name,
        interactive: markersInteractive,
        keyboard: markersInteractive,
        riseOnHover: markersInteractive,
        zIndexOffset: selected ? 1000 : 0,
      });
      marker.on('click', () => activatePlace(pin.id, false));
      marker.on('keydown', (event) =>
        onKeyActivate(event as L.LeafletKeyboardEvent, () => activatePlace(pin.id, true)),
      );
      entries.set(pin.id, { marker, pin });
    }
    layout();
    const popup = popupRef.current;
    if (openId && popup && map.hasLayer(popup)) {
      const entry = entries.get(openId);
      const content = popup.getContent();
      if (!entry) map.closePopup(popup);
      else if (
        shown &&
        JSON.stringify(entry.pin) !== JSON.stringify(shown) &&
        content instanceof HTMLElement
      ) {
        // Only this popup's own place changed: say so in place, without setContent or update,
        // which would drop focus inside it and pan a map the member moved back to it.
        fillPlacePopup(content, entry.pin);
        if (shown.lat !== entry.pin.lat || shown.lng !== entry.pin.lng) {
          const { autoPan } = popup.options;
          popup.options.autoPan = false;
          popup.setLatLng([entry.pin.lat, entry.pin.lng]);
          popup.options.autoPan = autoPan;
        }
      }
    }
    // contentKey stands in for pins: equal data in new arrays must not touch the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const previous = selectedRef.current;
    const revealed = revealRef.current !== revealRequest;
    selectedRef.current = selectedPlaceId;
    revealRef.current = revealRequest;
    if (previous !== selectedPlaceId) {
      restyle(previous);
      restyle(selectedPlaceId);
      layout();
    }
    const fromMap = fromMapRef.current;
    fromMapRef.current = false;
    const entry = selectedPlaceId ? entriesRef.current.get(selectedPlaceId) : undefined;
    if (entry) {
      if (fromMap) return;
      let zoom = Math.max(map.getZoom(), SELECT_ZOOM);
      while (
        zoom < MAX_CLUSTER_ZOOM &&
        clusterPlaces(latest.current.pins, zoom).some(
          (group) => group.length > 1 && group.includes(entry.pin),
        )
      )
        zoom++;
      // A new zoom regroups the pins when it ends, so focus waits for the pin's own marker.
      const zooming = zoom !== map.getZoom();
      if (focusOnReveal && zooming) pendingFocusRef.current = entry.pin.id;
      map.setView([entry.pin.lat, entry.pin.lng], zoom, { animate: !prefersReducedMotion() });
      openPlacePopup(entry.pin.id, false);
      if (focusOnReveal && !zooming) element(entry.pin.id)?.focus({ preventScroll: true });
    } else if (!selectedPlaceId && (previous || revealed)) {
      if (popupRef.current) map.closePopup(popupRef.current);
      fitPlaces(map, latest.current.pins, !prefersReducedMotion());
    }
  }, [selectedPlaceId, revealRequest]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!picking || !pickedLocation) {
      pickedMarkerRef.current?.remove();
      pickedMarkerRef.current = null;
      return;
    }
    const at = L.latLng(pickedLocation.lat, pickedLocation.lng);
    if (pickedMarkerRef.current) pickedMarkerRef.current.setLatLng(at);
    else
      pickedMarkerRef.current = L.marker(at, {
        icon: pickedIcon(),
        interactive: false,
        keyboard: false,
        zIndexOffset: 2000,
      }).addTo(map);
  }, [picking, pickedLocation?.lat, pickedLocation?.lng]);

  const tooFar = view.zoom < PICK_MIN_ZOOM;
  const canvasLabel = picking
    ? 'Map for pinning the new location. Arrow keys move the map, plus and minus zoom, and Enter pins the map center once zoomed in.'
    : preview
      ? `Map preview of ${plural(pins.length, 'place')} where bets were made`
      : 'Map of places where bets were made. Arrow keys move the map and plus and minus zoom.';
  const mapBox = (
    <div
      className={`places-map${compact ? ' places-map--compact' : ''}${picking ? ' places-map--picking' : ''}${preview ? ' places-map--static' : ''}${framed ? ' places-map--framed' : ''}`}
    >
      <div
        ref={containerRef}
        className="places-map-canvas"
        role={preview ? 'group' : 'region'}
        aria-label={canvasLabel}
      />
      {picking && <span className="places-map-reticle" aria-hidden="true" />}
      {touchHint && (
        <div className="places-map-touch-hint" aria-hidden="true">
          Use two fingers to move the map
        </div>
      )}
      {tileError && (
        <div className="places-map-notice" role="status">
          <span>Some map tiles did not load. Your places are still listed.</span>
          <button
            type="button"
            onClick={() => {
              // The notice (and this button) disappears, so keep focus on the map.
              containerRef.current?.focus();
              setTileError(false);
              tilesRef.current?.redraw();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {pins.length === 0 && !picking && (
        <div className="places-map-empty">
          <MapPin size={20} aria-hidden="true" />
          <span>
            Your next bet starts somewhere.
            <br />
            <strong>Pin a location when you put a bet on the record.</strong>
            {onAddPlace && (
              <button type="button" onClick={onAddPlace}>
                Start a bet with a place
              </button>
            )}
          </span>
        </div>
      )}
      {/* The picker's attribution already links OpenStreetMap, so it has this link only once. */}
      {framed && (
        <div className="places-map-credit">
          {pins.length > 0 && (
            <a
              className="places-map-external"
              href={`https://www.openstreetmap.org/#map=${view.zoom}/${view.lat.toFixed(5)}/${view.lng.toFixed(5)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={13} aria-hidden="true" />
              <span>OpenStreetMap</span>
              <span className="sr-only"> (opens this area in a new tab)</span>
            </a>
          )}
          {/* Leaflet's attribution control is moved in here when the map is made. */}
          <div className="places-map-attribution" ref={attributionSlotRef} />
        </div>
      )}
    </div>
  );
  if (!picking) return mapBox;
  return (
    <div className="places-map-picker">
      <div className="places-map-pick">
        <p>Select the spot on the map, or line it up under the crosshair and use the map center.</p>
        <div className="places-map-pick-actions">
          <button
            ref={centerButtonRef}
            type="button"
            disabled={tooFar}
            aria-describedby={tooFar ? noteId : undefined}
            onClick={() => {
              const map = mapRef.current;
              if (map) pickLocation(map.getCenter());
            }}
          >
            <Crosshair size={14} aria-hidden="true" />
            Use map center
          </button>
          {pickedLocation && onClearPin && (
            <button
              type="button"
              className="places-map-clear"
              onClick={() => {
                // Clear pin leaves with the pin: keep focus on the control before it, or the map.
                (tooFar ? containerRef.current : centerButtonRef.current)?.focus();
                onClearPin();
              }}
            >
              <X size={14} aria-hidden="true" />
              Clear pin
            </button>
          )}
          {tooFar && (
            <span className="places-map-pick-note" id={noteId}>
              Zoom in to the place first
            </span>
          )}
          <span className="sr-only" role="status">
            {pickRefusal}
          </span>
        </div>
      </div>
      {mapBox}
    </div>
  );
}

export default PlacesMap;
