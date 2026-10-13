import type { Itinerary, SearchResult } from "./search.js";
import type { Flight } from "./types.js";

const hm = (minutes: number) => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
const time = (local: string) => local.slice(11, 16);
const dateOf = (local: string) => local.slice(0, 10);

function leg(f: Flight): string {
  const op = f.marketingCarrier !== f.operatingCarrier ? ` (operated by ${f.operatingCarrier})` : "";
  const nextDay = dateOf(f.arrivalLocal) > dateOf(f.departureLocal) ? "+1" : "";
  return `${f.flightNumber.padEnd(7)} ${f.origin} ${time(f.departureLocal)} → ${f.destination} ${time(f.arrivalLocal)}${nextDay}${op}`;
}

export function formatItinerary(it: Itinerary, index: number): string {
  const flags = [it.overnightConnection ? "OVERNIGHT CONNECTION" : "", it.arrivalDayOffset > 0 ? `arrives +${it.arrivalDayOffset}d` : ""]
    .filter(Boolean)
    .join(", ");
  return [
    `${String(index + 1).padStart(2)}. via ${it.connection}  total ${hm(it.totalMinutes)}  layover ${hm(it.layoverMinutes)}${flags ? `  [${flags}]` : ""}`,
    `    ${dateOf(it.leg1.departureLocal)}  ${leg(it.leg1)}`,
    `    ${dateOf(it.leg2.departureLocal)}  ${leg(it.leg2)}`,
  ].join("\n");
}

export function formatResult(result: SearchResult): string {
  const lines: string[] = [];
  lines.push(`Connection stations checked: ${result.hubsConsidered.join(", ") || "none"}`);
  for (const s of result.hubsSkipped) lines.push(`  skipped ${s.hub}: ${s.reason}`);
  lines.push("");
  if (result.itineraries.length === 0) lines.push("No one-layover routes found.");
  else lines.push(...result.itineraries.map(formatItinerary));
  return lines.join("\n");
}
