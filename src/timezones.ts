import type { Iata } from "./types.js";

/**
 * IANA time zone for each station.
 *
 * PoC stopgap: a hand-maintained list of major airports. Replace with a full
 * airport dataset (e.g. OpenFlights airports.dat, which carries tz names)
 * before relying on it.
 */
const ZONES: Record<Iata, string> = {
  // Canada
  YYZ: "America/Toronto", YUL: "America/Toronto", YOW: "America/Toronto",
  YVR: "America/Vancouver", YYC: "America/Edmonton", YEG: "America/Edmonton",
  YWG: "America/Winnipeg", YHZ: "America/Halifax", YYT: "America/St_Johns",
  // United States
  JFK: "America/New_York", EWR: "America/New_York", LGA: "America/New_York",
  BOS: "America/New_York", IAD: "America/New_York", DCA: "America/New_York",
  PHL: "America/New_York", CLT: "America/New_York", ATL: "America/New_York",
  MIA: "America/New_York", MCO: "America/New_York", DTW: "America/Detroit",
  ORD: "America/Chicago", DFW: "America/Chicago", IAH: "America/Chicago",
  MSP: "America/Chicago", DEN: "America/Denver", PHX: "America/Phoenix",
  LAX: "America/Los_Angeles", SFO: "America/Los_Angeles",
  SEA: "America/Los_Angeles", LAS: "America/Los_Angeles", HNL: "Pacific/Honolulu",
  // Latin America
  MEX: "America/Mexico_City", CUN: "America/Cancun", BOG: "America/Bogota",
  LIM: "America/Lima", GRU: "America/Sao_Paulo", PTY: "America/Panama",
  // Europe
  LHR: "Europe/London", LGW: "Europe/London", DUB: "Europe/Dublin",
  CDG: "Europe/Paris", AMS: "Europe/Amsterdam", FRA: "Europe/Berlin",
  MUC: "Europe/Berlin", ZRH: "Europe/Zurich", MAD: "Europe/Madrid",
  BCN: "Europe/Madrid", FCO: "Europe/Rome", LIS: "Europe/Lisbon",
  CPH: "Europe/Copenhagen", IST: "Europe/Istanbul", KEF: "Atlantic/Reykjavik",
  // Middle East, Africa
  DXB: "Asia/Dubai", DOH: "Asia/Qatar", JNB: "Africa/Johannesburg",
  // Asia-Pacific
  DEL: "Asia/Kolkata", BOM: "Asia/Kolkata", SIN: "Asia/Singapore",
  HKG: "Asia/Hong_Kong", PEK: "Asia/Shanghai", PVG: "Asia/Shanghai",
  ICN: "Asia/Seoul", NRT: "Asia/Tokyo", HND: "Asia/Tokyo",
  SYD: "Australia/Sydney", MEL: "Australia/Melbourne", AKL: "Pacific/Auckland",
};

export type ZoneLookup = (station: Iata) => string;

export class UnknownStationError extends Error {
  constructor(public readonly station: Iata) {
    super(`No time zone known for station ${station}. Add it to src/timezones.ts.`);
  }
}

export const zoneFor: ZoneLookup = (station) => {
  const zone = ZONES[station.toUpperCase()];
  if (!zone) throw new UnknownStationError(station);
  return zone;
};
