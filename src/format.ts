import type { Itinerary, SearchResult } from "./search.js";
import type { CarrierCode, Flight } from "./types.js";

/** Describes the fare for a leg's operating carrier, e.g. "ZM" or "staff travel". */
export type CarrierLabel = (operatingCarrier: CarrierCode) => string | undefined;

const hm = (minutes: number) => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
const time = (local: string) => local.slice(11, 16);
const dateOf = (local: string) => local.slice(0, 10);

function leg(f: Flight, label: CarrierLabel): string {
  const op = f.marketingCarrier !== f.operatingCarrier ? ` (operated by ${f.operatingCarrier})` : "";
  const nextDay = dateOf(f.arrivalLocal) > dateOf(f.departureLocal) ? "+1" : "";
  const fare = label(f.operatingCarrier);
  return `${f.flightNumber.padEnd(7)} ${f.origin} ${time(f.departureLocal)} → ${f.destination} ${time(f.arrivalLocal)}${nextDay}${op}${fare ? `  [${fare}]` : ""}`;
}

const noLabel: CarrierLabel = () => undefined;

export function formatItinerary(it: Itinerary, index: number, label: CarrierLabel = noLabel): string {
  const flags = [it.overnightConnection ? "OVERNIGHT CONNECTION" : "", it.arrivalDayOffset > 0 ? `arrives +${it.arrivalDayOffset}d` : ""]
    .filter(Boolean)
    .join(", ");
  return [
    `${String(index + 1).padStart(2)}. via ${it.connection}  total ${hm(it.totalMinutes)}  layover ${hm(it.layoverMinutes)}${flags ? `  [${flags}]` : ""}`,
    `    ${dateOf(it.leg1.departureLocal)}  ${leg(it.leg1, label)}`,
    `    ${dateOf(it.leg2.departureLocal)}  ${leg(it.leg2, label)}`,
  ].join("\n");
}

export function formatResult(result: SearchResult, label: CarrierLabel = noLabel): string {
  const lines: string[] = [];
  lines.push(`Connection stations checked: ${result.hubsConsidered.join(", ") || "none"}`);
  for (const s of result.hubsSkipped) lines.push(`  skipped ${s.hub}: ${s.reason}`);
  lines.push("");
  if (result.itineraries.length === 0) lines.push("No one-layover routes found.");
  else lines.push(...result.itineraries.map((it, i) => formatItinerary(it, i, label)));
  return lines.join("\n");
}
