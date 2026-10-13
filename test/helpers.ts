import type { Flight } from "../src/types.js";

/** Build a flight: f("LHR-YYZ", "AC869", "2026-11-02T09:45", "2026-11-02T12:40", { op: "BA" }) */
export function f(route: string, flightNumber: string, dep: string, arr: string, extra: { op?: string } = {}): Flight {
  const [origin, destination] = route.split("-") as [string, string];
  const marketingCarrier = flightNumber.slice(0, 2);
  return {
    origin,
    destination,
    marketingCarrier,
    flightNumber,
    operatingCarrier: extra.op ?? marketingCarrier,
    departureLocal: dep,
    arrivalLocal: arr,
  };
}
