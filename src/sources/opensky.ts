import { DateTime } from "luxon";
import { HttpError, type PoliteFetcher } from "../http.js";
import { iataForAirline, iataForAirport, icaoFor, zoneFor } from "../stations.js";
import type { CarrierCode, Flight, FlightDataSource, Iata, RouteInfo } from "../types.js";

/**
 * OpenSky Network adapter (PoC data source). All knowledge of the OpenSky API
 * lives in this file. API docs: https://openskynetwork.github.io/opensky-api/rest.html
 *
 * OpenSky records flights its ADS-B receivers actually saw. It has no future
 * schedules, so:
 *   - Routes are the ones flown in the last ROUTE_WINDOW_DAYS available days.
 *   - Flights for a date are PROJECTED: the flights seen on the same weekday in
 *     the most recent week with data, moved forward by whole weeks (local wall
 *     clock). Times are when the aircraft was first/last seen, roughly
 *     take-off and landing, not published gate times.
 *   - Flight numbers come from ATC callsigns (BAW117 → BA117). Callsigns that
 *     are not plain numbers (BAW12K) are shown as they are.
 *   - Codes are ICAO (EGLL, BAW); src/stations.ts translates them to IATA.
 *     Callsigns are filed by the operating airline, so the carrier is the operator.
 *
 * Data is fetched one UTC day per request so every request URL is stable and
 * can be cached; finished days don't change.
 */

const API = "https://opensky-network.org/api";
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

const DAY_S = 24 * 60 * 60;
/** OpenSky adds a UTC day's flights in a nightly batch. Treat a day as ready this long after it ends. */
const AVAILABLE_AFTER_S = 6 * 60 * 60;
export const ROUTE_WINDOW_DAYS = 7;
/** Longest flight to expect. Bounds the arrival days fetched for one day's departures. */
const MAX_FLIGHT_S = 20 * 60 * 60;
/** A day that ended recently may still be filled in; re-check it sooner. */
const RECENT_DAY_TTL_MS = 6 * 60 * 60 * 1000;
const SETTLED_DAY_TTL_MS = 30 * DAY_S * 1000;

/** One record from /flights/departure or /flights/arrival (fields we use). */
export interface OpenSkyFlight {
  icao24: string;
  firstSeen: number;
  estDepartureAirport: string | null;
  lastSeen: number;
  estArrivalAirport: string | null;
  callsign: string | null;
}

export interface OpenSkyCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OpenSkyOptions {
  /** OAuth2 API client. Without it, requests are anonymous (tighter limits, may be refused). */
  credentials?: OpenSkyCredentials;
  /** For the token request, which bypasses the cache. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type Direction = "departure" | "arrival";

export class OpenSkyError extends Error {}

export class OpenSkySource implements FlightDataSource {
  /** Stations whose inbound routes were requested; their flights are read from arrivals. */
  private readonly inbound = new Set<Iata>();
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly fetcher: PoliteFetcher,
    private readonly opts: OpenSkyOptions = {},
  ) {}

  private nowS(): number {
    return Math.floor((this.opts.now ?? Date.now)() / 1000);
  }

  async getRoutesFrom(station: Iata): Promise<RouteInfo[]> {
    const days = routeWindow(this.nowS());
    return groupRoutes(await this.fetchDays("departure", icaoFor(station), days), "departure", station);
  }

  async getRoutesTo(station: Iata): Promise<RouteInfo[]> {
    this.inbound.add(station.toUpperCase());
    const days = routeWindow(this.nowS());
    return groupRoutes(await this.fetchDays("arrival", icaoFor(station), days), "arrival", station);
  }

  /**
   * Flights projected onto `date` (origin local). Read from the destination's
   * arrivals if its inbound routes were looked up (one set of requests then
   * serves every hub → destination leg), otherwise from the origin's departures.
   */
  async getFlights(origin: Iata, destination: Iata, date: string): Promise<Flight[]> {
    const fromArrivals = this.inbound.has(destination.toUpperCase());
    const ref = referenceDay(date, zoneFor(origin), fromArrivals ? MAX_FLIGHT_S : 0, availableUntil(this.nowS()));
    const raw = fromArrivals
      ? await this.fetchDays("arrival", icaoFor(destination), utcDays(ref.begin, ref.end + MAX_FLIGHT_S))
      : await this.fetchDays("departure", icaoFor(origin), utcDays(ref.begin, ref.end));
    return projectFlights(raw, origin, destination, ref);
  }

  private async fetchDays(direction: Direction, airport: string, dayStarts: number[]): Promise<OpenSkyFlight[]> {
    const seen = new Set<string>();
    const out: OpenSkyFlight[] = [];
    for (const begin of dayStarts) {
      const url = `${API}/flights/${direction}?airport=${airport}&begin=${begin}&end=${begin + DAY_S}`;
      const ttl = this.nowS() - (begin + DAY_S) < 2 * DAY_S ? RECENT_DAY_TTL_MS : SETTLED_DAY_TTL_MS;
      let body: string;
      try {
        // OpenSky answers 404 when it has no flights for the interval.
        body = await this.fetcher.get(url, ttl, { headers: () => this.authHeaders(), notFoundBody: "[]" });
      } catch (e) {
        throw explain(e);
      }
      for (const f of JSON.parse(body) as OpenSkyFlight[]) {
        // Day intervals share their boundary second; drop the repeat.
        const key = `${f.icao24}|${f.firstSeen}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
      }
    }
    return out;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const creds = this.opts.credentials;
    if (!creds) return {};
    if (!this.token || this.token.expiresAt <= this.nowS() + 60) {
      const res = await (this.opts.fetchImpl ?? fetch)(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
      });
      if (!res.ok) throw new OpenSkyError(`OpenSky login failed (HTTP ${res.status}). Check OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.`);
      const json = (await res.json()) as { access_token: string; expires_in: number };
      this.token = { value: json.access_token, expiresAt: this.nowS() + json.expires_in };
    }
    return { Authorization: `Bearer ${this.token.value}` };
  }
}

function explain(e: unknown): unknown {
  if (!(e instanceof HttpError)) return e;
  if (e.status === 401 || e.status === 403) {
    return new OpenSkyError(
      `OpenSky refused the request (HTTP ${e.status}). Set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET ` +
        `to an API client from your OpenSky account page.`,
    );
  }
  if (e.status === 429) return new OpenSkyError("OpenSky rate limit reached (HTTP 429). Your API credits for today may be used up.");
  return e;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** End (exclusive, epoch seconds) of the last UTC day OpenSky should have finished processing. */
export function availableUntil(nowS: number): number {
  const t = nowS - AVAILABLE_AFTER_S;
  return t - (((t % DAY_S) + DAY_S) % DAY_S);
}

/** Start of each UTC day in the route window: the ROUTE_WINDOW_DAYS days before availableUntil. */
export function routeWindow(nowS: number): number[] {
  const end = availableUntil(nowS);
  return Array.from({ length: ROUTE_WINDOW_DAYS }, (_, i) => end - (ROUTE_WINDOW_DAYS - i) * DAY_S);
}

/** Start of every UTC day overlapping [begin, end). */
export function utcDays(begin: number, end: number): number[] {
  const first = begin - (((begin % DAY_S) + DAY_S) % DAY_S);
  const out: number[] = [];
  for (let d = first; d < end; d += DAY_S) out.push(d);
  return out;
}

export interface ReferenceDay {
  /** The local date whose observed flights stand in for the requested one. */
  date: string;
  /** Its bounds in the origin's zone, epoch seconds [begin, end). */
  begin: number;
  end: number;
  /** How many weeks to move observed flights forward (0 = the date itself has data). */
  weeksBack: number;
}

/**
 * The latest same-weekday local date, `date` itself or whole weeks before it,
 * whose flights (plus `extraS` after the day for late arrivals) are all available.
 */
export function referenceDay(date: string, zone: string, extraS: number, availableUntilS: number): ReferenceDay {
  const target = DateTime.fromISO(date, { zone });
  if (!target.isValid) throw new Error(`Invalid date "${date}"`);
  let weeksBack = Math.max(0, Math.ceil((target.plus({ days: 1 }).toSeconds() + extraS - availableUntilS) / (7 * DAY_S)));
  for (;; weeksBack++) {
    const day = target.minus({ weeks: weeksBack });
    const begin = day.toSeconds();
    const end = day.plus({ days: 1 }).toSeconds();
    if (end + extraS <= availableUntilS) return { date: day.toISODate()!, begin, end, weeksBack };
  }
}

/** Airline and flight number from an ATC callsign, e.g. "BAW117  " → BA, BA117. */
export function parseCallsign(callsign: string | null): { carrier: CarrierCode; flightNumber: string } | undefined {
  const cs = callsign?.trim().toUpperCase() ?? "";
  const m = /^([A-Z]{3})([0-9][0-9A-Z]{0,3})$/.exec(cs);
  if (!m) return undefined;
  const carrier = iataForAirline(m[1]!);
  if (!carrier) return undefined;
  const flightNumber = /^\d+$/.test(m[2]!) ? `${carrier}${Number(m[2])}` : cs;
  return { carrier, flightNumber };
}

/** Routes seen in a list of departures (other end = arrival airport) or arrivals (other end = departure airport). */
export function groupRoutes(flights: OpenSkyFlight[], direction: Direction, station: Iata): RouteInfo[] {
  const byStation = new Map<Iata, Set<CarrierCode>>();
  for (const f of flights) {
    const otherIcao = direction === "departure" ? f.estArrivalAirport : f.estDepartureAirport;
    const other = otherIcao ? iataForAirport(otherIcao) : undefined;
    const carrier = parseCallsign(f.callsign)?.carrier;
    if (!other || !carrier || other === station.toUpperCase()) continue;
    const set = byStation.get(other) ?? new Set<CarrierCode>();
    set.add(carrier);
    byStation.set(other, set);
  }
  return [...byStation]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, carriers]) => ({ station: s, carriers: [...carriers].sort() }));
}

const local = (epochS: number, zone: string, weeks: number) =>
  DateTime.fromSeconds(epochS, { zone }).plus({ weeks }).toFormat("yyyy-MM-dd'T'HH:mm");

/** Observed origin → destination flights that left during `ref`, moved forward to the requested date. */
export function projectFlights(raw: OpenSkyFlight[], origin: Iata, destination: Iata, ref: ReferenceDay): Flight[] {
  const o = origin.toUpperCase();
  const d = destination.toUpperCase();
  const [oIcao, dIcao] = [icaoFor(o), icaoFor(d)];
  const out: Flight[] = [];
  for (const f of raw) {
    if (f.estDepartureAirport !== oIcao || f.estArrivalAirport !== dIcao) continue;
    if (f.firstSeen < ref.begin || f.firstSeen >= ref.end) continue;
    const cs = parseCallsign(f.callsign);
    if (!cs) continue;
    out.push({
      origin: o,
      destination: d,
      marketingCarrier: cs.carrier,
      operatingCarrier: cs.carrier,
      flightNumber: cs.flightNumber,
      departureLocal: local(f.firstSeen, zoneFor(o), ref.weeksBack),
      arrivalLocal: local(f.lastSeen, zoneFor(d), ref.weeksBack),
    });
  }
  return out.sort((a, b) => a.departureLocal.localeCompare(b.departureLocal));
}
