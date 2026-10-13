import { DateTime } from "luxon";
import { zoneFor as defaultZoneFor, UnknownStationError, type ZoneLookup } from "./stations.js";
import type { CarrierCode, Flight, FlightDataSource, Iata, RouteInfo } from "./types.js";

export interface SearchRequest {
  origin: Iata;
  destination: Iata;
  /** Travel date, YYYY-MM-DD, local to the origin. Leg 1 departs on this date. */
  date: string;
  /** Airlines the user can fly on (IATA codes). Matched against the operating carrier. */
  whitelist: CarrierCode[];
  /** "HH:mm", origin local time. Applies to leg 1 departure. */
  departAfter?: string;
  departBefore?: string;
  /** "HH:mm", destination local time of day. Applies to leg 2 arrival, on any day. */
  arriveAfter?: string;
  arriveBefore?: string;
}

export interface SearchOptions {
  /** MCT plus buffer for a self-transfer. */
  minConnectionMinutes: number;
  maxLayoverMinutes: number;
  zoneFor: ZoneLookup;
}

export const DEFAULT_OPTIONS: SearchOptions = {
  minConnectionMinutes: 90,
  maxLayoverMinutes: 12 * 60,
  zoneFor: defaultZoneFor,
};

export interface Itinerary {
  connection: Iata;
  leg1: Flight;
  leg2: Flight;
  layoverMinutes: number;
  totalMinutes: number;
  /** Leg 2 departs on a later local date than leg 1 arrives. */
  overnightConnection: boolean;
  /** Calendar days between the search date and the local arrival date at the destination. */
  arrivalDayOffset: number;
}

export interface SkippedHub {
  hub: Iata;
  reason: string;
}

export interface SearchResult {
  itineraries: Itinerary[];
  hubsConsidered: Iata[];
  hubsSkipped: SkippedHub[];
}

export class EmptyWhitelistError extends Error {
  constructor() {
    super("Your airline whitelist is empty. Add the airlines you can fly on first.");
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function normalizeWhitelist(codes: CarrierCode[]): Set<CarrierCode> {
  return new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean));
}

function at(local: string, station: Iata, zones: ZoneLookup): DateTime {
  const dt = DateTime.fromISO(local, { zone: zones(station) });
  if (!dt.isValid) throw new Error(`Invalid local time "${local}" at ${station}`);
  return dt;
}

function minutesOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  const h = Number(m?.[1]);
  const min = Number(m?.[2]);
  if (!m || h > 23 || min > 59) throw new Error(`Invalid time "${hhmm}", expected HH:mm`);
  return h * 60 + min;
}

function inWindow(dt: DateTime, after?: string, before?: string): boolean {
  const t = dt.hour * 60 + dt.minute;
  if (after !== undefined && t < minutesOfDay(after)) return false;
  if (before !== undefined && t > minutesOfDay(before)) return false;
  return true;
}

function servedStations(routes: RouteInfo[], whitelist: Set<CarrierCode>): Set<Iata> {
  return new Set(
    routes
      .filter((r) => r.carriers.some((c) => whitelist.has(c.toUpperCase())))
      .map((r) => r.station.toUpperCase()),
  );
}

/**
 * Stations served non-stop from both ends on a whitelisted airline.
 * `destinationSpokes` are the destination's routes, outbound or inbound.
 */
export function candidateHubs(
  fromOrigin: RouteInfo[],
  destinationSpokes: RouteInfo[],
  whitelist: Set<CarrierCode>,
  origin: Iata,
  destination: Iata,
): Iata[] {
  const a = servedStations(fromOrigin, whitelist);
  const b = servedStations(destinationSpokes, whitelist);
  return [...a].filter((x) => b.has(x) && x !== origin && x !== destination).sort();
}

/** Whether `routes` (out of some station) include `destination` on a whitelisted airline. */
export function servesWith(routes: RouteInfo[], destination: Iata, whitelist: Set<CarrierCode>): boolean {
  return servedStations(routes, whitelist).has(destination.toUpperCase());
}

/**
 * Collapse codeshares: the same physical flight listed under several marketing
 * flight numbers. Keeps the operating carrier's own listing when present.
 */
export function dedupeCodeshares(flights: Flight[]): Flight[] {
  const byKey = new Map<string, Flight>();
  for (const f of flights) {
    const key = [f.origin, f.destination, f.operatingCarrier, f.departureLocal, f.arrivalLocal].join("|");
    const existing = byKey.get(key);
    if (!existing || (existing.marketingCarrier !== existing.operatingCarrier && f.marketingCarrier === f.operatingCarrier)) {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()];
}

function isWhitelisted(f: Flight, wl: Set<CarrierCode>): boolean {
  return wl.has(f.operatingCarrier.toUpperCase());
}

export function eligibleLeg1(flights: Flight[], req: SearchRequest, wl: Set<CarrierCode>, zones: ZoneLookup): Flight[] {
  return dedupeCodeshares(flights).filter((f) => {
    if (!isWhitelisted(f, wl)) return false;
    const dep = at(f.departureLocal, f.origin, zones);
    return dep.toISODate() === req.date && inWindow(dep, req.departAfter, req.departBefore);
  });
}

export function eligibleLeg2(flights: Flight[], req: SearchRequest, wl: Set<CarrierCode>, zones: ZoneLookup): Flight[] {
  return dedupeCodeshares(flights).filter(
    (f) => isWhitelisted(f, wl) && inWindow(at(f.arrivalLocal, f.destination, zones), req.arriveAfter, req.arriveBefore),
  );
}

function sortItineraries(list: Itinerary[], zones: ZoneLookup): Itinerary[] {
  return list.sort(
    (x, y) =>
      x.totalMinutes - y.totalMinutes ||
      at(x.leg1.departureLocal, x.leg1.origin, zones).toMillis() - at(y.leg1.departureLocal, y.leg1.origin, zones).toMillis(),
  );
}

/** Pair leg-1 and leg-2 flights into valid connections. Pure: no I/O. */
export function pairFlights(
  leg1s: Flight[],
  leg2s: Flight[],
  req: SearchRequest,
  options: Partial<SearchOptions> = {},
): Itinerary[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const zones = opts.zoneFor;
  const wl = normalizeWhitelist(req.whitelist);
  const searchDate = DateTime.fromISO(req.date, { zone: "utc" });
  const out: Itinerary[] = [];

  for (const a of eligibleLeg1(leg1s, req, wl, zones)) {
    const depA = at(a.departureLocal, a.origin, zones);
    const arrA = at(a.arrivalLocal, a.destination, zones);
    for (const b of eligibleLeg2(leg2s, req, wl, zones)) {
      if (b.origin !== a.destination) continue;
      const depB = at(b.departureLocal, b.origin, zones);
      const layover = depB.diff(arrA, "minutes").minutes;
      if (layover < opts.minConnectionMinutes || layover > opts.maxLayoverMinutes) continue;
      const arrB = at(b.arrivalLocal, b.destination, zones);
      const arrivalDate = DateTime.fromISO(arrB.toISODate()!, { zone: "utc" });
      out.push({
        connection: a.destination,
        leg1: a,
        leg2: b,
        layoverMinutes: Math.round(layover),
        totalMinutes: Math.round(arrB.diff(depA, "minutes").minutes),
        overnightConnection: depB.toISODate()! > arrA.toISODate()!,
        arrivalDayOffset: Math.round(arrivalDate.diff(searchDate, "days").days),
      });
    }
  }
  return sortItineraries(out, zones);
}

/** Local dates at the hub on which a leg 2 could depart, given the leg-1 arrivals. */
export function leg2Dates(leg1s: Flight[], options: Partial<SearchOptions> = {}): string[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (leg1s.length === 0) return [];
  const arrivals = leg1s.map((f) => at(f.arrivalLocal, f.destination, opts.zoneFor));
  const first = DateTime.min(...arrivals)!.plus({ minutes: opts.minConnectionMinutes }).startOf("day");
  const last = DateTime.max(...arrivals)!.plus({ minutes: opts.maxLayoverMinutes });
  const dates: string[] = [];
  for (let d = first; d <= last; d = d.plus({ days: 1 })) dates.push(d.toISODate()!);
  return dates;
}

// ---------------------------------------------------------------------------
// Orchestration (talks to the data source)
// ---------------------------------------------------------------------------

/**
 * Hub-and-spoke search, as described in CLAUDE.md:
 * spokes(origin) ∩ spokes(destination) → verify hub → destination → pair dated flights.
 * If the source can list routes *into* the destination, those are used as its
 * spokes and the per-hub direction check is not needed.
 * Calls the source sequentially; the source is responsible for throttling and caching.
 */
export async function findRoutes(
  request: SearchRequest,
  source: FlightDataSource,
  options: Partial<SearchOptions> = {},
): Promise<SearchResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const req = { ...request, origin: request.origin.toUpperCase(), destination: request.destination.toUpperCase() };
  const wl = normalizeWhitelist(req.whitelist);
  if (wl.size === 0) throw new EmptyWhitelistError();
  if (req.origin === req.destination) throw new Error("Origin and destination must be different stations.");
  if (!DateTime.fromISO(req.date).isValid || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) {
    throw new Error(`Invalid date "${req.date}", expected YYYY-MM-DD`);
  }
  // Fail fast on stations we can't place in a time zone.
  opts.zoneFor(req.origin);
  opts.zoneFor(req.destination);

  const fromOrigin = await source.getRoutesFrom(req.origin);
  const inbound = source.getRoutesTo !== undefined;
  const destinationSpokes = source.getRoutesTo
    ? await source.getRoutesTo(req.destination)
    : await source.getRoutesFrom(req.destination);
  const hubs = candidateHubs(fromOrigin, destinationSpokes, wl, req.origin, req.destination);

  const itineraries: Itinerary[] = [];
  const hubsSkipped: SkippedHub[] = [];

  for (const hub of hubs) {
    try {
      opts.zoneFor(hub);
    } catch (e) {
      if (!(e instanceof UnknownStationError)) throw e;
      hubsSkipped.push({ hub, reason: "unknown time zone" });
      continue;
    }

    // Step 4: the destination's spokes are flights *out of* it; confirm hub → destination exists.
    if (!inbound && !servesWith(await source.getRoutesFrom(hub), req.destination, wl)) {
      hubsSkipped.push({ hub, reason: `no ${hub}→${req.destination} route on a whitelisted airline` });
      continue;
    }

    const leg1 = eligibleLeg1(await source.getFlights(req.origin, hub, req.date), req, wl, opts.zoneFor);
    if (leg1.length === 0) continue;

    const leg2: Flight[] = [];
    for (const date of leg2Dates(leg1, opts)) {
      leg2.push(...(await source.getFlights(hub, req.destination, date)));
    }
    itineraries.push(...pairFlights(leg1, leg2, req, opts));
  }

  return { itineraries: sortItineraries(itineraries, opts.zoneFor), hubsConsidered: hubs, hubsSkipped };
}
