import type { FurnitureItem, LocationDefinition } from '../domain/types';

export const WORLD_LOCATIONS: LocationDefinition[] = [
  {
    id: 'home',
    name: 'Home',
    description: 'Your place. Decorate it, display trophies, and eventually invite other players over.',
    route: 'home',
    district: 'Residential',
    initiallyUnlocked: true,
    kind: 'home',
  },
  {
    id: 'downtown',
    name: 'Downtown',
    description: 'The first public district. Shops, story contacts, and locked destinations will branch from here.',
    route: 'map',
    district: 'Central',
    initiallyUnlocked: true,
    kind: 'social',
  },
  {
    id: 'underpass',
    name: 'The Underpass',
    description: 'Something is moving below the service road. This is the first combat test location.',
    route: 'underpass',
    district: 'Central',
    initiallyUnlocked: true,
    kind: 'combat',
  },
];

export const FURNITURE_CATALOG: FurnitureItem[] = [
  { id: 'starter-bed', name: 'Beat-Up Bed', icon: 'BED' },
  { id: 'starter-chair', name: 'Plastic Chair', icon: 'CHR' },
  { id: 'starter-lamp', name: 'Floor Lamp', icon: 'LMP' },
  { id: 'starter-rug', name: 'Cheap Rug', icon: 'RUG' },
  { id: 'tunnel-trophy', name: 'Underpass Trophy', icon: 'TRP' },
];

export const getFurniture = (id: string): FurnitureItem | undefined =>
  FURNITURE_CATALOG.find((item) => item.id === id);
