// LC2-alpha core, with separately versioned iRail side tables.
import { Bool, Field, Float32, Float64, Int32, Int64, Schema, Uint8, Uint32, Utf8 } from 'apache-arrow';
import core from './lc-core-schemas.json' with { type: 'json' };

export const coreDefinitions = core;
export const extensionVersion = '1-alpha';

const types = { Bool, Float32, Float64, Int32, Int64, Uint8, Uint32, Utf8 };
const field = (name, type, nullable = false) => ({ name, type, nullable });
const run = [field('tripIdx', 'Int32'), field('serviceDate', 'Uint32')];
const event = [...run, field('stopSequence', 'Uint32')];
const observation = [field('source', 'Utf8'), field('observedAt', 'Int64')];

export const extensionDefinitions = {
  // One row per curated station, including stations that are not in the GTFS feed. `name` is the neutral name;
  // an empty alternative means the neutral name applies to that language.
  stations: [
    field('name', 'Utf8'),
    ...['alternativeFr', 'alternativeNl', 'alternativeDe', 'alternativeEn', 'tafTapCode', 'telegraphCode', 'countryCode'].map((name) => field(name, 'Utf8', true)),
    field('lat', 'Float64'), field('lon', 'Float64'),
    field('avgStopTimes', 'Float64', true), field('officialTransferTime', 'Uint32', true),
  ],
  stopEnrichment: [
    field('stopIdx', 'Int32'), field('stopId', 'Utf8'), field('regionIdx', 'Int32', true),
    field('stationIri', 'Utf8', true), field('stationId', 'Utf8', true), field('hafasId', 'Utf8', true),
    ...['nameNl', 'nameFr', 'nameDe', 'nameEn', 'countryCode', 'tafTapCode', 'telegraphCode', 'platformCode'].map((name) => field(name, 'Utf8', true)),
    field('officialTransferTime', 'Uint32', true), field('avgStopTimes', 'Float64', true),
    field('wheelchairBoarding', 'Uint8', true),
  ],
  tripEnrichment: [
    field('tripIdx', 'Int32'), field('tripId', 'Utf8'),
    field('vehicleIri', 'Utf8', true), field('shapeIdx', 'Int32'), field('geometryIdx', 'Int32'),
    field('directionId', 'Uint8', true), field('blockId', 'Utf8', true), field('wheelchairAccessible', 'Uint8', true),
    field('bikesAllowed', 'Uint8', true),
  ],
  routeEnrichment: [
    field('routeIdx', 'Int32'), field('routeId', 'Utf8'), field('agencyId', 'Utf8'), field('product', 'Utf8', true),
  ],
  connectionEnrichment: [
    field('departureHeadsign', 'Utf8', true), field('arrivalHeadsign', 'Utf8', true),
    field('departureShapeDistance', 'Float64', true), field('arrivalShapeDistance', 'Float64', true),
  ],
  transferEnrichment: [field('transferIdx', 'Int32')],
  shapes: [field('shapeId', 'Utf8'), field('path', 'Utf8'), field('pointCount', 'Uint32'), field('distanceUnit', 'Utf8', true)],
  shapePoints: [field('sequence', 'Uint32'), field('lat', 'Float64'), field('lon', 'Float64'), field('distance', 'Float64', true)],
  compositions: [
    ...run, field('segmentId', 'Utf8'), field('fromStopSequence', 'Uint32'), field('toStopSequence', 'Uint32'),
    field('position', 'Uint32'), field('unitUic', 'Utf8', true), field('materialNumber', 'Utf8', true),
    ...['materialType', 'materialSubType', 'materialSubTypeName', 'tractionType', 'orientation', 'confirmedBy'].map((name) => field(name, 'Utf8', true)),
    ...['seatsFirstClass', 'seatsSecondClass', 'seatsCoupeFirstClass', 'seatsCoupeSecondClass', 'standingPlacesFirstClass', 'standingPlacesSecondClass', 'tractionPosition'].map((name) => field(name, 'Uint32', true)),
    field('lengthInMeter', 'Float32', true),
    ...['hasToilet', 'hasPrmToilet', 'hasTables', 'hasFirstClassOutlets', 'hasSecondClassOutlets', 'hasHeating', 'hasAirco', 'hasBikeSection', 'canPassToNextUnit', 'hasSemiAutomaticInteriorDoors', 'hasLuggageSection', 'hasPrmSection', 'hasPriorityPlaces'].map((name) => field(name, 'Bool', true)),
    ...observation,
  ],
  occupancy: [
    ...event, field('level', 'Utf8'), field('score', 'Float32', true), ...observation, field('expiresAt', 'Int64', true),
  ],
  alerts: [
    field('alertId', 'Utf8'), field('language', 'Utf8'), field('type', 'Utf8'),
    ...['header', 'lead', 'description', 'company', 'linksJson'].map((name) => field(name, 'Utf8', true)),
    ...['validFrom', 'validTo', 'modifiedAt'].map((name) => field(name, 'Int64', true)), ...observation,
  ],
  alertEntities: [
    field('alertId', 'Utf8'), ...['stopIdx', 'routeIdx', 'tripIdx'].map((name) => field(name, 'Int32', true)),
    field('serviceDate', 'Uint32', true), field('stopSequence', 'Uint32', true),
  ],
  stopStatus: [
    ...event,
    ...['arrivalPlatform', 'departurePlatform'].map((name) => field(name, 'Utf8', true)),
    ...['arrivalCancelled', 'departureCancelled', 'isExtra'].map((name) => field(name, 'Bool', true)),
    ...['arrivalState', 'departureState', 'notesJson'].map((name) => field(name, 'Utf8', true)),
    ...observation,
  ],
  delaysCancellations: [
    ...event, field('scope', 'Utf8'), field('scheduleRelationship', 'Utf8'),
    ...['arrivalTime', 'departureTime'].map((name) => field(name, 'Int64', true)),
    ...['arrivalDelay', 'departureDelay', 'assignedStopIdx'].map((name) => field(name, 'Int32', true)),
    field('uncertainty', 'Uint32', true), ...observation,
  ],
};

// IRIs are the interchange identity; integer indices remain release-local accelerators.
const iriFields = {
  connectionEnrichment: ['iri', 'tripIri', 'runIri', 'departureStopIri', 'arrivalStopIri', 'departureCallIri', 'arrivalCallIri'],
  stations: ['iri'],
  stopEnrichment: ['iri'],
  tripEnrichment: ['iri', 'routeIri'],
  routeEnrichment: ['iri', 'agencyIri'],
  transferEnrichment: ['iri'],
  shapes: ['iri'],
  shapePoints: ['iri', 'shapeIri'],
  compositions: ['iri', 'tripIri', 'runIri', 'fromCallIri', 'toCallIri', 'sourceIri'],
  occupancy: ['iri', 'callIri', 'sourceIri'],
  alerts: ['iri', 'sourceIri'],
  alertEntities: ['iri', 'alertIri'],
  stopStatus: ['iri', 'callIri', 'sourceIri'],
  delaysCancellations: ['iri', 'tripIri', 'runIri', 'sourceIri'],
};
const nullableIriFields = {
  stopEnrichment: ['parentIri'], tripEnrichment: ['shapeIri'],
  transferEnrichment: ['fromStopIri', 'toStopIri', 'fromTripIri', 'toTripIri', 'fromRouteIri', 'toRouteIri'],
  compositions: ['unitIri'],
  alertEntities: ['stopIri', 'routeIri', 'tripIri', 'runIri', 'callIri'],
  delaysCancellations: ['callIri', 'assignedStopIri'],
};
for (const [dataset, names] of Object.entries(iriFields)) extensionDefinitions[dataset].push(...names.map(name => field(name, 'Utf8')));
for (const [dataset, names] of Object.entries(nullableIriFields)) extensionDefinitions[dataset].push(...names.map(name => field(name, 'Utf8', true)));

export const definitions = { ...coreDefinitions, ...extensionDefinitions };

export function schemaFor(name, metadata = {}) {
  if (!definitions[name]) throw new Error(`Unknown dataset: ${name}`);
  const baseline = Object.hasOwn(coreDefinitions, name)
    ? { schemaVersion: '2-alpha', dataset: name }
    : { format: 'irail-cdn-extensions', schemaVersion: extensionVersion, identityProfile: 'irail-global-v1', dataset: name };
  for (const [key, value] of Object.entries(baseline)) {
    if (metadata[key] !== undefined && metadata[key] !== value) throw new Error(`Invalid ${name} metadata: ${key}`);
  }
  return new Schema(
    definitions[name].map(({ name, type, nullable }) => new Field(name, new types[type](), nullable)),
    new Map(Object.entries({ ...metadata, ...baseline })),
  );
}
