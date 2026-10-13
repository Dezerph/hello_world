import type { Flight, FlightDataSource, Iata, RouteInfo } from "../types.js";

/** Data source backed by a fixed list of flights. Used by tests and `--demo`. */
export class InMemorySource implements FlightDataSource {
  readonly calls: string[] = [];

  constructor(private readonly flights: Flight[]) {}

  async getRoutesFrom(station: Iata): Promise<RouteInfo[]> {
    this.calls.push(`routes ${station}`);
    const byDest = new Map<Iata, Set<string>>();
    for (const f of this.flights) {
      if (f.origin !== station) continue;
      const set = byDest.get(f.destination) ?? new Set<string>();
      set.add(f.operatingCarrier);
      byDest.set(f.destination, set);
    }
    return [...byDest].map(([destination, carriers]) => ({ destination, carriers: [...carriers] }));
  }

  async getFlights(origin: Iata, destination: Iata, date: string): Promise<Flight[]> {
    this.calls.push(`flights ${origin}-${destination} ${date}`);
    return this.flights.filter(
      (f) => f.origin === origin && f.destination === destination && f.departureLocal.startsWith(date),
    );
  }
}
