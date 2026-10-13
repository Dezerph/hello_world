/** 3-letter IATA station (airport) code, e.g. "YYZ". */
export type Iata = string;
/** 2-letter IATA airline code, e.g. "AC". */
export type CarrierCode = string;

/** A non-stop route between a station and `station`, and the airlines that fly it. */
export interface RouteInfo {
  /** The other end of the route: its destination for getRoutesFrom, its origin for getRoutesTo. */
  station: Iata;
  carriers: CarrierCode[];
}

/** One scheduled flight (a segment). */
export interface Flight {
  origin: Iata;
  destination: Iata;
  marketingCarrier: CarrierCode;
  flightNumber: string;
  /** The airline actually flying it. Staff travel eligibility is checked against this. */
  operatingCarrier: CarrierCode;
  /** Local time at the origin, "YYYY-MM-DDTHH:mm". */
  departureLocal: string;
  /** Local time at the destination, "YYYY-MM-DDTHH:mm". */
  arrivalLocal: string;
}

/** Where routes and schedules come from. OpenSky for the PoC; swappable later. */
export interface FlightDataSource {
  /** Non-stop routes out of `station`. */
  getRoutesFrom(station: Iata): Promise<RouteInfo[]>;
  /**
   * Non-stop routes into `station`. Optional: when present the search uses it for
   * the destination's spokes and skips checking each hub's routes separately.
   */
  getRoutesTo?(station: Iata): Promise<RouteInfo[]>;
  /** Flights departing `origin` for `destination` on `date` (YYYY-MM-DD, origin local). */
  getFlights(origin: Iata, destination: Iata, date: string): Promise<Flight[]>;
}
