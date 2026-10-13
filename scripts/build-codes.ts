/**
 * Regenerates src/data/airports.json and src/data/airlines.json.
 *
 * OpenSky identifies airports and airlines by ICAO code; the app works in IATA.
 * These two tables translate between them (and give each airport its IANA zone).
 *
 *   NODE_USE_ENV_PROXY=1 npm run build-codes
 *
 * Sources (see src/data/README.md for licences):
 *   airports: https://github.com/mwgg/Airports (MIT)
 *   airlines: https://github.com/jpatokal/openflights airlines.dat (ODbL), plus OVERRIDES below
 */
import { writeFile } from "node:fs/promises";
import { IANAZone } from "luxon";

const AIRPORTS_URL = "https://raw.githubusercontent.com/mwgg/Airports/master/airports.json";
const AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat";
const OUT = new URL("../src/data/", import.meta.url);

/**
 * ICAO airline designator → IATA code fixes. OpenFlights stopped being updated
 * around 2017, so it misses newer airlines and has some stale or clashing rows.
 * These win over the dataset. Add to this list when a whitelisted airline is missing.
 */
const OVERRIDES: Record<string, string> = {
  SWR: "LX", // Swiss (dataset also maps it to defunct Swissair)
  TGW: "TR", // Scoot
  ITY: "AZ", // ITA Airways
  MXY: "MX", // Breeze Airways
  DWI: "DM", // Arajet
  POE: "PD", // Porter Airlines
  FLE: "F8", // Flair Airlines
  PTB: "2Z", // Voepass
  AIE: "3H", // Air Inuit
  SIL: "3M", // Silver Airways
  OCN: "4Y", // Discover Airlines
  TIN: "8T", // Air Tindi
  GLR: "9M", // Central Mountain Air
  FDY: "9X", // Southern Airways Express
  CRQ: "YN", // Air Creebec
  SPR: "PB", // PAL Airlines
  PSC: "P6", // Pascan Aviation
  VIV: "VB", // Viva Aerobus
  WIA: "WM", // Winair
  DJT: "B0", // La Compagnie
};

async function get(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return res.text();
}

/** Minimal CSV line parser for airlines.dat (quoted fields, \N for null). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"]|"")*)"|([^,]*))\s*(?:,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) && m[0] !== "") out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]!);
  return out;
}

async function buildAirports(): Promise<Record<string, [string, string]>> {
  const raw = JSON.parse(await get(AIRPORTS_URL)) as Record<string, { icao: string; iata: string; tz: string }>;
  const out: Record<string, [string, string]> = {};
  for (const a of Object.values(raw)) {
    if (!/^[A-Z]{3}$/.test(a.iata) || !/^[A-Z0-9]{4}$/.test(a.icao) || !IANAZone.isValidZone(a.tz)) continue;
    out[a.iata] = [a.icao, a.tz];
  }
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
}

async function buildAirlines(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await get(AIRLINES_URL)).split(/\r?\n/)) {
    const [, name = "", , iata = "", icao = "", , , active = ""] = parseCsvLine(line);
    if (active !== "Y" || !/^[A-Z0-9]{2}$/.test(iata) || !/^[A-Z]{3}$/.test(icao)) continue;
    // Freighter flights are not open to staff travel; don't let them create routes.
    if (/cargo|freight/i.test(name)) continue;
    out[icao] = iata;
  }
  Object.assign(out, OVERRIDES);
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
}

const airports = await buildAirports();
const airlines = await buildAirlines();
await writeFile(new URL("airports.json", OUT), JSON.stringify(airports) + "\n");
await writeFile(new URL("airlines.json", OUT), JSON.stringify(airlines) + "\n");
console.log(`Wrote ${Object.keys(airports).length} airports and ${Object.keys(airlines).length} airline designators.`);
