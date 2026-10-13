import { DateTime } from "luxon";
import type { Flight } from "../types.js";

/**
 * MADE-UP schedules for `--demo`, so the search can be tried before the
 * flightsfrom.com parser exists. Flight numbers and times are illustrative only.
 * Repeats every day; covers LHR → YVR plus a few return spokes out of YVR.
 */
const DAILY: [string, string, string, string, string, string, string, number][] = [
  // origin, dest, marketing, flight no, operating, dep, arr, arr day offset
  ["LHR", "YYZ", "AC", "AC869", "AC", "09:45", "12:40", 0],
  ["LHR", "YYZ", "BA", "BA93", "BA", "15:15", "18:10", 0],
  ["LHR", "YYZ", "AC", "AC5501", "BA", "15:15", "18:10", 0], // codeshare of BA93
  ["YYZ", "YVR", "AC", "AC105", "AC", "14:30", "16:45", 0],
  ["YYZ", "YVR", "AC", "AC115", "AC", "19:30", "21:47", 0],
  ["YYZ", "YVR", "WS", "WS711", "WS", "20:00", "22:20", 0],
  ["YYZ", "YVR", "AC", "AC101", "AC", "06:00", "08:20", 0],
  ["LHR", "ORD", "UA", "UA929", "UA", "10:30", "13:20", 0],
  ["ORD", "YVR", "UA", "UA2208", "UA", "16:00", "18:30", 0],
  ["LHR", "SEA", "BA", "BA49", "BA", "13:00", "15:00", 0],
  ["SEA", "YVR", "AS", "AS2100", "QX", "17:30", "18:30", 0],
  ["LHR", "YUL", "AC", "AC865", "AC", "12:00", "14:30", 0],
  // Spokes out of YVR (the destination). YVR→YUL exists but YUL→YVR does not.
  ["YVR", "YYZ", "AC", "AC100", "AC", "08:00", "15:30", 0],
  ["YVR", "ORD", "UA", "UA2209", "UA", "08:00", "14:00", 0],
  ["YVR", "SEA", "AS", "AS2101", "QX", "07:00", "08:00", 0],
  ["YVR", "YUL", "AC", "AC302", "AC", "09:00", "16:20", 0],
  ["YVR", "LHR", "BA", "BA84", "BA", "19:55", "13:10", 1],
];

export function sampleFlights(fromDate: string, days = 3): Flight[] {
  const start = DateTime.fromISO(fromDate);
  const flights: Flight[] = [];
  for (let i = 0; i < days; i++) {
    const day = start.plus({ days: i });
    for (const [origin, destination, mkt, no, op, dep, arr, offset] of DAILY) {
      flights.push({
        origin,
        destination,
        marketingCarrier: mkt,
        flightNumber: no,
        operatingCarrier: op,
        departureLocal: `${day.toISODate()}T${dep}`,
        arrivalLocal: `${day.plus({ days: offset }).toISODate()}T${arr}`,
      });
    }
  }
  return flights;
}
