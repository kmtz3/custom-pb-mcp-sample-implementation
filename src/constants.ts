export const BASE_US = 'https://api.productboard.com';
export const BASE_EU = 'https://api.eu.productboard.com';
export const CHARACTER_LIMIT = 25000;

// Entity types supported by the PB v2 API
export const ENTITY_TYPES = [
  'product',
  'component',
  'feature',
  'subfeature',
  'initiative',
  'objective',
  'keyResult',
  'release',
  'releaseGroup',
  'company',
  'user',
] as const;
export type EntityType = typeof ENTITY_TYPES[number];

// These types require a parent_id when creating
export const ENTITY_TYPES_REQUIRING_PARENT: readonly EntityType[] = [
  'feature',
  'subfeature',
  'component',
  'keyResult',
  'release',
] as const;

// Types that support timeframe (startDate, endDate, granularity)
export const HAS_TIMEFRAME: ReadonlySet<EntityType> = new Set([
  'objective', 'keyResult', 'initiative', 'feature', 'subfeature', 'release',
]);

// Types that support health (mode, status, comment)
export const HEALTH_TYPES: ReadonlySet<EntityType> = new Set([
  'objective', 'keyResult', 'initiative', 'feature', 'subfeature',
]);

// Types that support progress tracking (startValue, currentValue, targetValue)
export const HAS_PROGRESS: ReadonlySet<EntityType> = new Set(['keyResult']);

// Phase field is only supported on initiatives
export const HAS_PHASE: ReadonlySet<EntityType> = new Set(['initiative']);

// Cascade rules: deleting a type also deletes its descendants
// Used to warn callers about side effects
export const ENTITY_CASCADE_ANCESTORS: Partial<Record<EntityType, readonly EntityType[]>> = {
  keyResult:  ['objective'],
  component:  ['product'],
  feature:    ['component', 'product'],
  subfeature: ['feature', 'component', 'product'],
  release:    ['releaseGroup'],
} as const;
