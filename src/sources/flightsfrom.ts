import type { PoliteFetcher } from "../http.js";
import type { Flight, FlightDataSource, Iata, RouteInfo } from "../types.js";

/**
 * flightsfrom.com adapter (PoC data source). All knowledge of the site's pages
 * lives in this file.
 *
 * STATUS: the page parsers below are not written yet. The site could not be
 * reached from the environment this was built in, so its HTML has not been
 * inspected. Next steps:
 *   1. Save real pages as fixtures under test/fixtures/flightsfrom/.
 *   2. Confirm the route/schedule URL (ROUTE_URL is a guess).
 *   3. Implement the two parse functions against those fixtures.
 */

const BASE = "https://www.flightsfrom.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const ROUTES_TTL_MS = DAY_MS;
const SCHEDULE_TTL_MS = 6 * 60 * 60 * 1000;

export const destinationsUrl = (station: Iata) => `${BASE}/${station.toUpperCase()}/destinations`;
/** UNVERIFIED guess at the per-route page that lists flight times. */
export const routeUrl = (origin: Iata, destination: Iata) =>
  `${BASE}/${origin.toUpperCase()}-${destination.toUpperCase()}`;

export class NotImplementedError extends Error {}

export class FlightsFromSource implements FlightDataSource {
  constructor(private readonly fetcher: PoliteFetcher) {}

  async getRoutesFrom(station: Iata): Promise<RouteInfo[]> {
    const html = await this.fetcher.get(destinationsUrl(station), ROUTES_TTL_MS);
    return parseDestinationsPage(html, station);
  }

  async getFlights(origin: Iata, destination: Iata, date: string): Promise<Flight[]> {
    const html = await this.fetcher.get(routeUrl(origin, destination), SCHEDULE_TTL_MS);
    return parseRoutePage(html, origin, destination, date);
  }
}

/** Parse `/{IATA}/destinations` into the station's non-stop routes and their airlines. */
export function parseDestinationsPage(_html: string, station: Iata): RouteInfo[] {
  throw new NotImplementedError(
    `flightsfrom.com destinations parser not implemented yet (station ${station}). See src/sources/flightsfrom.ts.`,
  );
}

/** Parse a route page into the flights departing on `date` (origin local). */
export function parseRoutePage(_html: string, origin: Iata, destination: Iata, date: string): Flight[] {
  throw new NotImplementedError(
    `flightsfrom.com schedule parser not implemented yet (${origin}-${destination} on ${date}). See src/sources/flightsfrom.ts.`,
  );
}
