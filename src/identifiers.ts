import { createIriStrategy, defaultIriConfiguration, serviceDate, type IriConfiguration, type IriRegistry } from './iri-strategy.ts';
export { absoluteIri, createIriStrategy, defaultIriConfiguration, IriRegistry } from './iri-strategy.ts';
export type { IriConfiguration, Resolver } from './iri-strategy.ts';

export const DEFAULT_ID_BASE = defaultIriConfiguration.identityBase!;

// The same bundled registry is used by builders and Worker collectors. A full JSON
// override is useful when several deployments share one independently managed registry.
export function iriConfiguration(env: { ID_BASE_URL?: string; IRI_STRATEGY_JSON?: string } = {}): IriConfiguration {
  const config = env.IRI_STRATEGY_JSON ? JSON.parse(env.IRI_STRATEGY_JSON) as IriConfiguration : defaultIriConfiguration;
  return { ...config, identityBase: env.ID_BASE_URL ?? config.identityBase };
}

export function identifiers(sourceId: string, config: string | IriConfiguration = defaultIriConfiguration, registry?: IriRegistry) {
  const strategy = createIriStrategy(sourceId, typeof config === 'string' ? { ...defaultIriConfiguration, identityBase: config } : config, registry);
  const mint = strategy.mint;
  const keyed = (kind: string, root: string, key: string) => mint(kind, { [root]: { key } }, [key]);
  const event = (kind: string, tripKey: string, date: number | string, sequence?: number) => {
    const day = serviceDate(date);
    if (sequence !== undefined && (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff)) throw new Error('Invalid stop sequence');
    return mint(kind, { trips: { key: tripKey }, connection: { serviceDate: day, stopSequence: sequence } },
      sequence === undefined ? [tripKey, day] : [tripKey, day, sequence]);
  };
  return {
    ...strategy,
    source: mint('source', {}, [sourceId]),
    provider: (channel: string) => keyed('provider', 'provider', channel),
    stop: (key: string) => keyed('stop', 'stops', key),
    route: (key: string) => keyed('route', 'routes', key),
    agency: (key: string) => keyed('agency', 'agency', key),
    trip: (key: string) => keyed('trip', 'trips', key),
    shape: (key: string) => keyed('shape', 'shapes', key),
    unit: (key: string) => keyed('unit', 'unit', key),
    run: (key: string, date: number | string) => event('run', key, date),
    call: (key: string, date: number | string, sequence: number) => event('call', key, date, sequence),
    connection: (key: string, date: number | string, sequence: number) => event('connection', key, date, sequence),
    entity: (kind: string, key: string) => mint('entity', { entity: { kind, key } }, [kind, key]),
  };
}

// Only call with a verified station UIC, never an arbitrary platform/raw international ID.
export function sncbStationIri(uic: string): string {
  const match = /^(?:00)?(\d{7})$/.exec(uic);
  if (!match) throw new Error('SNCB station UIC must have seven digits or a 00 prefix');
  const key = match[1]!;
  return createIriStrategy('nmbs-sncb').mint('station', { stops: { key, uic: key } }, [key]);
}
