import { lazy, Suspense, type ComponentProps } from 'react';
import { MapPin } from 'lucide-react';
import type { PlacesMap as PlacesMapComponent } from './PlacesMap';

const LazyPlacesMap = lazy(() =>
  import('./PlacesMap').then((module) => ({ default: module.PlacesMap })),
);

export function MapView(props: ComponentProps<typeof PlacesMapComponent>) {
  return (
    <Suspense
      fallback={
        // The map's own size classes, so the placeholder fills the same box whether or not the
        // map stylesheet has arrived yet.
        <div
          className={`places-map${props.compact ? ' places-map--compact' : ''} map-loading${props.compact ? ' map-loading-compact' : ''}`}
          role="status"
        >
          <MapPin size={22} aria-hidden="true" />
          <span>Loading places…</span>
        </div>
      }
    >
      <LazyPlacesMap {...props} />
    </Suspense>
  );
}
