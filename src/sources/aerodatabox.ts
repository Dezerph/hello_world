import type { PoliteFetcher } from "../http.js";
import type { Flight, FlightDataSource, Iata, RouteInfo } from "../types.js";

/**
 * AeroDataBox adapter (https://aerodatabox.com, via RapidAPI). All knowledge of
 * the API's shapes lives in this file.
 *
 * - Routes: `GET /airports/iata/{code}/stats/routes/daily/{date}` lists the
 *   destinations of a station and the airlines flying them.
 * - Schedules: the FIDS endpoint returns an airport's departures for a local
 *   time window of at most 12 h, so a day costs two calls per airport. Results
 *   are filtered to the wanted destination here, and cached per airport and day,
 *   so every route out of one airport shares them.
 *
 * Codeshares are dropped (`codeshareStatus` != IsOperator): the operating
 * flight is returned once, under its own flight number.
 *
 * Caveat: the response shapes follow the published API models; fixtures in
 * test/fixtures/aerodatabox are hand-written from them, not recorded. Replace
 * them with real responses once you have a key.
 */

const DEFAULT_BASE = "https://aerodatabox.p.rapidapi.com";
const HOST_HEADER = "aerodatabox.p.rapidapi.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const ROUTES_TTL_MS = DAY_MS;
const SCHEDULE_TTL_MS = 6 * 60 * 60 * 1000;

export class MissingApiKeyError extends Error {
  constructor() {
    super("Set AERODATABOX_API_KEY (your RapidAPI key for AeroDataBox) to search real schedules, or use --demo.");
  }
}

export interface AeroDataBoxOptions {
  apiKey: string;
  baseUrl?: string;
  /** Today's date (YYYY-MM-DD), used for the route stats request. */
  today?: () => string;
}

export const routesUrl = (base: string, station: Iata, date: string) =>
  `${base}/airports/iata/${station.toUpperCase()}/stats/routes/daily/${date}`;

/** The two 12-hour windows covering one local day. */
export const fidsUrls = (base: string, station: Iata, date: string): string[] =>
  [
    [`${date}T00:00`, `${date}T11:59`],
    [`${date}T12:00`, `${date}T23:59`],
  ].map(
    ([from, to]) =>
      `${base}/flights/airports/iata/${station.toUpperCase()}/${from}/${to}` +
      "?direction=Departure&withCancelled=false&withCargo=false&withPrivate=false&withLocation=false",
  );

export class AeroDataBoxSource implements FlightDataSource {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly today: () => string;
  private readonly departures = new Map<string, Promise<Flight[]>>();

  constructor(
    private readonly fetcher: PoliteFetcher,
    opts: AeroDataBoxOptions,
  ) {
    if (!opts.apiKey) throw new MissingApiKeyError();
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.headers = { "X-RapidAPI-Key": opts.apiKey, "X-RapidAPI-Host": HOST_HEADER, Accept: "application/json" };
    this.today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  }

  async getRoutesFrom(station: Iata): Promise<RouteInfo[]> {
    const body = await this.get(routesUrl(this.base, station, this.today()), ROUTES_TTL_MS);
    return parseRoutes(body);
  }

  async getFlights(origin: Iata, destination: Iata, date: string): Promise<Flight[]> {
    const key = `${origin.toUpperCase()} ${date}`;
    let all = this.departures.get(key);
    if (!all) {
      all = this.loadDepartures(origin, date);
      this.departures.set(key, all);
      all.catch(() => this.departures.delete(key));
    }
    const dest = destination.toUpperCase();
    return (await all).filter((f) => f.destination === dest);
  }

  private async loadDepartures(origin: Iata, date: string): Promise<Flight[]> {
    const flights: Flight[] = [];
    for (const url of fidsUrls(this.base, origin, date)) {
      flights.push(...parseDepartures(await this.get(url, SCHEDULE_TTL_MS), origin));
    }
    return flights.filter((f) => f.departureLocal.startsWith(date));
  }

  private get(url: string, ttl: number): Promise<string> {
    return this.fetcher.get(url, ttl, { headers: this.headers, checkRobots: false });
  }
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

interface Airline {
  iata?: string;
}
interface Time {
  local?: string;
}
interface Movement {
  airport?: { iata?: string };
  scheduledTime?: Time;
}
interface FidsFlight {
  number?: string;
  codeshareStatus?: string;
  isCargo?: boolean;
  airline?: Airline;
  movement?: Movement;
  departure?: Movement;
  arrival?: Movement;
}

export function parseRoutes(json: string): RouteInfo[] {
  const data = JSON.parse(json) as { routes?: { destination?: { iata?: string }; operators?: Airline[] }[] };
  const out: RouteInfo[] = [];
  for (const r of data.routes ?? []) {
    const destination = r.destination?.iata?.toUpperCase();
    if (!destination) continue;
    const carriers = [...new Set((r.operators ?? []).map((o) => o.iata?.toUpperCase()).filter((c): c is string => !!c))];
    out.push({ destination, carriers });
  }
  return out;
}

/** Local time "2026-11-02 09:45+00:00" → "2026-11-02T09:45". */
export function localMinute(t: Time | undefined): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(t?.local ?? "");
  return m ? `${m[1]}T${m[2]}` : undefined;
}

/** Parse a FIDS response (direction=Departure) into operated, scheduled flights out of `origin`. */
export function parseDepartures(json: string, origin: Iata): Flight[] {
  const data = JSON.parse(json) as { departures?: FidsFlight[] };
  const out: Flight[] = [];
  for (const d of data.departures ?? []) {
    if (d.codeshareStatus !== "IsOperator" || d.isCargo) continue;
    // For departures the queried airport is `movement` (older docs: `departure`); the other end is `arrival`.
    const dep = d.movement ?? d.departure;
    const arr = d.arrival;
    const departureLocal = localMinute(dep?.scheduledTime);
    const arrivalLocal = localMinute(arr?.scheduledTime);
    const destination = arr?.airport?.iata?.toUpperCase();
    const parts = /^([A-Z0-9]{2})\s*(\d+\w?)$/i.exec((d.number ?? "").trim());
    if (!departureLocal || !arrivalLocal || !destination || !parts) continue;
    const carrier = parts[1]!.toUpperCase();
    out.push({
      origin: origin.toUpperCase(),
      destination,
      marketingCarrier: carrier,
      flightNumber: `${carrier}${parts[2]}`,
      operatingCarrier: (d.airline?.iata ?? carrier).toUpperCase(),
      departureLocal,
      arrivalLocal,
    });
  }
  return out;
}
