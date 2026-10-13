import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PoliteFetcher } from "../src/http.js";
import { AeroDataBoxSource, MissingApiKeyError, localMinute, parseDepartures, parseRoutes } from "../src/sources/aerodatabox.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", "aerodatabox", name), "utf8");

describe("parseRoutes", () => {
  it("lists destinations with operator codes and skips entries without an IATA code", async () => {
    expect(parseRoutes(await fixture("routes-lhr.json"))).toEqual([
      { destination: "YVR", carriers: ["BA", "AC"] },
      { destination: "KEF", carriers: ["FI"] },
    ]);
  });
});

describe("parseDepartures", () => {
  it("keeps operated passenger flights, with local times at each end", async () => {
    const flights = parseDepartures(await fixture("fids-lhr.json"), "LHR");
    expect(flights).toEqual([
      { origin: "LHR", destination: "YVR", marketingCarrier: "BA", flightNumber: "BA85", operatingCarrier: "BA", departureLocal: "2026-11-02T09:45", arrivalLocal: "2026-11-02T13:10" },
      { origin: "LHR", destination: "KEF", marketingCarrier: "FI", flightNumber: "FI450", operatingCarrier: "FI", departureLocal: "2026-11-02T23:55", arrivalLocal: "2026-11-03T02:05" },
    ]);
  });

  it("drops codeshares (the operator's own entry carries the flight)", async () => {
    const flights = parseDepartures(await fixture("fids-lhr.json"), "LHR");
    expect(flights.some((f) => f.flightNumber === "AA6085")).toBe(false);
  });

  it("parses offsets-bearing local timestamps", () => {
    expect(localMinute({ local: "2026-11-02 13:10-08:00" })).toBe("2026-11-02T13:10");
    expect(localMinute({})).toBeUndefined();
  });
});

describe("AeroDataBoxSource", () => {
  async function setup() {
    const requests: { url: string; headers: Headers }[] = [];
    const fids = await fixture("fids-lhr.json");
    const empty = JSON.stringify({ departures: [] });
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.includes("/stats/routes/")) return new Response(await fixture("routes-lhr.json"));
      return new Response(url.includes("T00:00") ? fids : empty);
    }) as typeof fetch;
    let clock = 0;
    const fetcher = new PoliteFetcher({
      cacheDir: await mkdtemp(join(tmpdir(), "zed-")),
      userAgent: "zed-routes/0.1",
      minIntervalMs: 0,
      fetchImpl,
      now: () => clock++,
    });
    return { requests, source: new AeroDataBoxSource(fetcher, { apiKey: "k3y", today: () => "2026-11-01" }) };
  }

  it("requires an API key", () => {
    expect(() => new AeroDataBoxSource({} as PoliteFetcher, { apiKey: "" })).toThrow(MissingApiKeyError);
  });

  it("sends the key, skips robots.txt, and shares one day of departures across destinations", async () => {
    const { requests, source } = await setup();
    expect(await source.getRoutesFrom("LHR")).toHaveLength(2);
    expect(await source.getFlights("LHR", "YVR", "2026-11-02")).toHaveLength(1);
    expect(await source.getFlights("lhr", "kef", "2026-11-02")).toHaveLength(1);

    expect(requests.some((r) => r.url.endsWith("robots.txt"))).toBe(false);
    expect(requests.every((r) => r.headers.get("x-rapidapi-key") === "k3y")).toBe(true);
    const fidsCalls = requests.filter((r) => r.url.includes("/flights/airports/"));
    expect(fidsCalls).toHaveLength(2); // two 12 h windows, once
    expect(fidsCalls[0]!.url).toContain("/2026-11-02T00:00/2026-11-02T11:59");
    expect(fidsCalls[1]!.url).toContain("/2026-11-02T12:00/2026-11-02T23:59");
    expect(requests[0]!.url).toContain("/airports/iata/LHR/stats/routes/daily/2026-11-01");
  });
});
