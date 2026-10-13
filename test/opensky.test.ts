import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PoliteFetcher } from "../src/http.js";
import { findRoutes } from "../src/search.js";
import {
  availableUntil,
  groupRoutes,
  type OpenSkyFlight,
  OpenSkySource,
  parseCallsign,
  projectFlights,
  referenceDay,
  routeWindow,
} from "../src/sources/opensky.js";

const s = (iso: string) => Date.parse(iso) / 1000;
const iso = (epochS: number) => new Date(epochS * 1000).toISOString().slice(0, 10);
let aircraft = 0;
const rec = (callsign: string | null, dep: string | null, arr: string | null, first: string, last: string): OpenSkyFlight => ({
  icao24: (++aircraft).toString(16).padStart(6, "0"),
  firstSeen: s(first),
  estDepartureAirport: dep,
  lastSeen: s(last),
  estArrivalAirport: arr,
  callsign,
});

// Tuesday 13 Oct 2026, 16:00Z. Monday 12 Oct is the latest finished UTC day.
const NOW_S = s("2026-10-13T16:00:00Z");
const fixture = async (name: string) => readFile(new URL(`./fixtures/opensky/${name}`, import.meta.url), "utf8");

describe("parseCallsign", () => {
  it("turns numeric callsigns into IATA flight numbers", () => {
    expect(parseCallsign("BAW117  ")).toEqual({ carrier: "BA", flightNumber: "BA117" });
    expect(parseCallsign("ACA0869")).toEqual({ carrier: "AC", flightNumber: "AC869" });
    expect(parseCallsign("JZA8123")).toEqual({ carrier: "QK", flightNumber: "QK8123" });
  });

  it("keeps alphanumeric callsigns as they are", () => {
    expect(parseCallsign("BAW12K")).toEqual({ carrier: "BA", flightNumber: "BAW12K" });
  });

  it("rejects unknown airlines, registrations and blanks", () => {
    expect(parseCallsign("QQQ123")).toBeUndefined();
    expect(parseCallsign("N123AB")).toBeUndefined();
    expect(parseCallsign("GEC8170")).toBeUndefined(); // Lufthansa Cargo: freighters are excluded
    expect(parseCallsign("        ")).toBeUndefined();
    expect(parseCallsign(null)).toBeUndefined();
  });
});

describe("data windows", () => {
  it("waits for OpenSky's nightly batch before using a day", () => {
    expect(iso(availableUntil(NOW_S))).toBe("2026-10-13"); // 12 Oct is usable
    expect(iso(availableUntil(s("2026-10-13T03:00:00Z")))).toBe("2026-10-12"); // too early for 12 Oct
    expect(routeWindow(NOW_S).map(iso)).toEqual([
      "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12",
    ]);
  });

  it("projects a future date from the latest same weekday with data", () => {
    const until = availableUntil(NOW_S);
    expect(referenceDay("2026-11-02", "Europe/London", 0, until)).toMatchObject({ date: "2026-10-12", weeksBack: 3 });
    // Monday 12 Oct in Toronto runs to 04:00Z on the 13th; adding late arrivals pushes it a week further back.
    expect(referenceDay("2026-11-02", "America/Toronto", 20 * 3600, until)).toMatchObject({ date: "2026-10-05", weeksBack: 4 });
    // A past date uses its own flights.
    expect(referenceDay("2026-10-01", "America/Toronto", 0, until)).toMatchObject({ date: "2026-10-01", weeksBack: 0 });
  });
});

describe("groupRoutes", () => {
  it("groups by the other airport and keeps only known airlines and airports", async () => {
    const flights = JSON.parse(await fixture("departures-EGLL-2026-10-12.json")) as OpenSkyFlight[];
    expect(groupRoutes(flights, "departure", "LHR")).toEqual([
      { station: "DUB", carriers: ["BA"] },
      { station: "ORD", carriers: ["UA"] },
      { station: "YUL", carriers: ["AC"] },
      { station: "YYZ", carriers: ["AC", "BA"] },
    ]);
    const inbound = [rec("ACA105", "CYYZ", "CYVR", "2026-10-05T18:30:00Z", "2026-10-05T23:45:00Z")];
    expect(groupRoutes(inbound, "arrival", "YVR")).toEqual([{ station: "YYZ", carriers: ["AC"] }]);
  });
});

describe("projectFlights", () => {
  it("moves observed flights forward by whole weeks on the local wall clock, across a DST change", () => {
    const raw = [
      rec("ACA869  ", "EGLL", "CYYZ", "2026-10-12T08:45:00Z", "2026-10-12T16:40:00Z"),
      rec("ACA865  ", "EGLL", "CYUL", "2026-10-12T11:00:00Z", "2026-10-12T18:30:00Z"), // other route
      rec("ACA849  ", "EGLL", "CYYZ", "2026-10-11T22:30:00Z", "2026-10-12T06:00:00Z"), // 23:30 BST on 11 Oct: other day
    ];
    const ref = referenceDay("2026-11-02", "Europe/London", 0, availableUntil(NOW_S));
    // Seen 09:45 BST → 12:40 EDT; Europe and North America are back on standard time by 2 Nov.
    expect(projectFlights(raw, "LHR", "YYZ", ref)).toEqual([
      {
        origin: "LHR",
        destination: "YYZ",
        marketingCarrier: "AC",
        operatingCarrier: "AC",
        flightNumber: "AC869",
        departureLocal: "2026-11-02T09:45",
        arrivalLocal: "2026-11-02T12:40",
      },
    ]);
  });
});

/** Fake OpenSky: serves per-day responses keyed by direction, airport and UTC date; 404 otherwise. */
function fakeOpenSky(days: Record<string, string>) {
  const requests: { url: string; auth?: string }[] = [];
  let tokens = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "auth.opensky-network.org") {
      tokens++;
      return Response.json({ access_token: `tok${tokens}`, expires_in: 1800 });
    }
    requests.push({ url: url.href, auth: (init?.headers as Record<string, string>)["Authorization"] });
    const key = `${url.pathname.split("/").pop()} ${url.searchParams.get("airport")} ${iso(Number(url.searchParams.get("begin")))}`;
    const body = days[key];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { requests, fetchImpl, tokens: () => tokens };
}

async function source(net: ReturnType<typeof fakeOpenSky>) {
  const fetcher = new PoliteFetcher({
    cacheDir: await mkdtemp(join(tmpdir(), "zed-opensky-")),
    userAgent: "zed-routes/test",
    minIntervalMs: 0,
    respectRobots: false,
    fetchImpl: net.fetchImpl,
    now: () => NOW_S * 1000,
  });
  return new OpenSkySource(fetcher, {
    credentials: { clientId: "id", clientSecret: "secret" },
    fetchImpl: net.fetchImpl,
    now: () => NOW_S * 1000,
  });
}

describe("OpenSkySource", () => {
  it("finds routes from origin departures and destination arrivals, without per-hub lookups", async () => {
    const net = fakeOpenSky({
      "departure EGLL 2026-10-12": await fixture("departures-EGLL-2026-10-12.json"),
      // Arrivals into YVR from YYZ: Monday 5 Oct (projects to Mon 2 Nov) and Tuesday 6 Oct (→ Tue 3 Nov).
      "arrival CYVR 2026-10-05": JSON.stringify([
        rec("ACA105  ", "CYYZ", "CYVR", "2026-10-05T18:30:00Z", "2026-10-05T23:45:00Z"),
      ]),
      "arrival CYVR 2026-10-06": JSON.stringify([
        rec("ACA101  ", "CYYZ", "CYVR", "2026-10-06T10:00:00Z", "2026-10-06T15:20:00Z"),
      ]),
    });

    const result = await findRoutes(
      { origin: "LHR", destination: "YVR", date: "2026-11-02", whitelist: ["AC", "BA"] },
      await source(net),
    );

    expect(result.hubsConsidered).toEqual(["YYZ"]); // YUL is served from LHR but has no flights into YVR
    expect(result.hubsSkipped).toEqual([]);
    expect(
      result.itineraries.map((i) => `${i.leg1.flightNumber} ${i.leg1.departureLocal}+${i.leg2.flightNumber} ${i.leg2.departureLocal}`),
    ).toEqual(["AC869 2026-11-02T09:45+AC105 2026-11-02T14:30", "BA93 2026-11-02T15:15+AC101 2026-11-03T06:00"]);
    expect(result.itineraries[0]).toMatchObject({ layoverMinutes: 110, totalMinutes: 15 * 60 });

    // Only LHR departures and YVR arrivals are fetched, each UTC day once, all signed in.
    const fetched = net.requests.map((r) => r.url);
    expect(fetched.every((u) => /departure\?airport=EGLL|arrival\?airport=CYVR/.test(u))).toBe(true);
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(fetched).toHaveLength(15); // 7 + 7 route-window days, plus 5 Oct for the projected leg 2
    expect(net.requests.every((r) => r.auth === "Bearer tok1")).toBe(true);
    expect(net.tokens()).toBe(1);
  });

  it("counts a flight once when two day responses both include it", async () => {
    const boundary = rec("ACA115  ", "CYYZ", "CYVR", "2026-10-06T23:30:00Z", "2026-10-07T04:00:00Z");
    const net = fakeOpenSky({
      "arrival CYVR 2026-10-06": JSON.stringify([boundary]),
      "arrival CYVR 2026-10-07": JSON.stringify([boundary]),
    });
    const src = await source(net);
    await src.getRoutesTo("YVR");
    expect((await src.getFlights("YYZ", "YVR", "2026-11-03")).map((f) => f.flightNumber)).toEqual(["AC115"]);
  });

  it("explains a refused request", async () => {
    const net = fakeOpenSky({});
    const fetchImpl = (async (input: string | URL) =>
      String(input).includes("/token") ? Response.json({ access_token: "t", expires_in: 1800 }) : new Response("", { status: 403 })) as typeof fetch;
    const src = await source({ ...net, fetchImpl });
    await expect(src.getRoutesFrom("LHR")).rejects.toThrow(/OPENSKY_CLIENT_ID/);
  });
});
