# CLAUDE.md

Project context for Claude Code and other contributors.

## What this project is

A route finder for airline employees who travel standby on staff ("ZED") fares.
The user picks an origin station, a destination station, a date and an optional
time window. The app returns every routing with **one layover** (two flight
segments) between the two stations. The two segments can be on different
airlines, as long as staff travel is allowed on each one.

The main use case is an employee getting **home** from a work location or a trip,
so results should help them choose the routing with the best chance of
getting on board.

## Domain glossary

- **Station**: an airport, identified by its 3-letter IATA code (e.g. `LHR`, `JFK`).
- **Standby / non-rev**: the employee has no confirmed seat. They board only if
  seats are left after paying passengers are accommodated.
- **ZED (Zonal Employee Discount)**: the industry framework for discounted staff
  travel on *other* airlines. Fares are set by the flight's distance zone and a
  fare level (commonly Low / Medium / High) agreed between the two airlines.
- **ZED / interline agreement**: a bilateral agreement between the employee's
  airline and another carrier. Staff can only fly ZED on carriers their airline
  has an agreement with. (MIBA, the Multilateral Interline Benefits Agreement,
  is a related framework some carriers use.)
- **Home carrier**: the airline the user works for. Its own flights are usually
  available under a separate staff travel scheme, not ZED.
- **Operating vs. marketing carrier**: codeshares are sold under one airline's
  code but flown by another. Staff travel eligibility usually depends on the
  **operating** carrier, so filtering must use it.
- **Segment**: a single flight between two stations. A one-layover route has
  two segments: origin → connection → destination.
- **MCT (Minimum Connection Time)**: the shortest legal connection at an airport.
  ZED tickets are normally separate tickets, so the employee self-transfers (may
  need to re-check bags or clear immigration). The app should apply a buffer
  above MCT.

## Core user flow

1. Select **origin** station (searchable airport picker).
2. Select **destination** station.
3. Pick a **date** with a date picker.
4. Optionally give a **departure and/or arrival time window**.
5. Submit. The app lists every eligible 1-layover route:
   - Leg 1: carrier, flight number, departure and arrival times
   - Connection station and layover duration
   - Leg 2: carrier, flight number, departure and arrival times
   - Total journey time
   - (Later) fare zone and level, plus a standby-load indicator if the data exists

## Routing rules

- A route is exactly `origin → X → destination`, where `X` is neither the
  origin nor the destination.
- Both segments must be on an **operating carrier in the user's airline
  whitelist** (see below). The two segments do **not** have to be on the same
  airline. Any whitelisted carrier can be paired with any other.
- Leg 2 must depart at least `MCT + buffer` after leg 1 arrives at `X`.
  Defaults are open to change; until decided, use ~90 min for an international
  self-transfer and cap layovers at ~12 h.
- Use the **local time** of each station for display. Use UTC (or tz-aware
  datetimes) for every comparison, because routes cross time zones and the date line.
- The time window filters on leg 1 departure and/or leg 2 arrival.
- Connections that run overnight (leg 2 on the next day) should be supported
  but flagged.
- Sort by total journey time by default.

## Airline whitelist

The user keeps a list of the airlines they can fly on: their home carrier plus
every carrier their airline has a ZED agreement with. The app does not try to
work out ZED agreements itself.

- Store airlines by their 2-letter IATA code (e.g. `AC`, `LH`) and show the
  airline names in the UI.
- The whitelist is a **user setting**, saved between searches. It is not entered
  on each search.
- Every search filters both legs on it, matching the **operating** carrier.
- If the whitelist is empty, show a prompt to set it up instead of results.

## PoC data source: OpenSky Network (hub and spoke)

For the proof of concept, route and flight data comes from the
[OpenSky Network REST API](https://openskynetwork.github.io/opensky-api/rest.html)
(`/flights/departure` and `/flights/arrival` by airport). It replaced scraping
flightsfrom.com. OpenSky records flights its ADS-B receivers **actually saw**. It
has **no future schedules**, and that shapes everything below.

Search algorithm:

1. **Origin spokes:** departures from ORIG over the last 7 days with data,
   keeping routes flown by a whitelisted airline.
2. **Destination spokes:** arrivals **into** DEST over the same 7 days, filtered
   the same way. These are real inbound routes, so the old "verify the direction
   of leg 2" step (one lookup per hub) is not needed. `findRoutes` still does that
   check for sources without `getRoutesTo`.
3. **Candidate connections** = stations in both sets, minus origin and destination.
4. **Flights for the date are projected.** Take the flights seen on the same
   weekday in the most recent week with data, and move them forward by whole weeks
   on the local wall clock (so DST changes are handled). Leg 1 is read from ORIG's
   departures and leg 2 from DEST's arrivals, so one set of requests serves every hub.
   Then pair flights using the connection rules above.

What the data means (show these caveats to the user):

- Times are when the aircraft was first and last seen: roughly take-off and
  landing, not published gate times. They include that day's delays.
- Schedule changes are missed until they have been flown: the IATA season switch
  at the end of October and in late March, new routes, cancellations.
- A diverted flight looks like a real route on the day it happened.
- Flight numbers come from ATC callsigns (`BAW117` → `BA117`). Alphanumeric
  callsigns (`BAW12K`) are shown as is.
- Callsigns are filed by the **operating** airline, which is what the whitelist
  needs. Regional partners fly under their own codes (Jazz = `QK` for Air
  Canada Express), so they must be whitelisted separately.
- Coverage is thin over oceans and in parts of Africa and Asia; airports there
  may be missing (`estArrivalAirport: null`).
- OpenSky uses ICAO codes. `src/stations.ts` maps them to IATA using generated
  tables in `src/data/` (see its README for sources and licences).

Fetch rules:

- One UTC day per request (`begin`/`end` = that day), so every URL is stable and
  cacheable. Finished days are cached for 30 days; days that ended in the last
  48 h for 6 h, because OpenSky fills days in with a nightly batch. A day is
  only used 6 h after it ends.
- OpenSky answers 404 for "no flights"; treat it as an empty list.
- Requests are throttled to about 1 per second, one at a time. Accounts have a
  daily credit budget, and HTTP 429 means it's used up.
- Auth: OAuth2 client credentials. Set `OPENSKY_CLIENT_ID` and
  `OPENSKY_CLIENT_SECRET` (API client from the OpenSky account page). Without
  them requests are anonymous and may be refused.
- Licence: OpenSky data is for research and non-commercial use. Anything beyond
  a personal PoC needs an agreement with OpenSky or a licensed schedule provider.

Keep the data source behind an interface so a licensed schedule API can replace it:

```
get_routes_from(station) -> [(station, [carrier_codes])]
get_routes_to(station)   -> [(station, [carrier_codes])]   (optional)
get_flights(origin, dest, date) -> [Flight(carrier, flight_no, dep_local, arr_local, operating_carrier)]
```

## Data the app needs

| Data | Purpose | Notes |
|---|---|---|
| Airports | Station picker, time zones, IATA↔ICAO | `src/data/airports.json`, generated from mwgg/Airports |
| Airline codes | Callsign (ICAO) → IATA airline | `src/data/airlines.json`, generated from OpenFlights plus overrides |
| Routes and flights | Building the segments | PoC: OpenSky observed flights (see above). Later: a licensed schedules API (AeroDataBox, OAG, Cirium, etc.) for real future schedules |
| Airline whitelist | Filtering by carrier eligibility | Entered by the user (see above) |
| MCT per airport | Connection validity | Use a configurable default to start |

Do not scrape airline or staff-travel portals. They usually require staff
credentials and their terms forbid automated access.

## Open questions (decide before building much)

- UI platform (web app, mobile, or both). The PoC is a TypeScript CLI.
- The OpenSky adapter is built from the API docs and has not yet been run
  against the live API (the build environment couldn't reach it). Save real
  responses as fixtures under `test/fixtures/opensky/` once it has.
- Long-term schedule data provider for real future schedules (AeroDataBox is
  the likely candidate): cost, coverage and rate limits.
- Should **direct flights** appear alongside the 1-layover routes?
- Will 2-layover routes be needed later? (Design the search so the number of hops can be raised.)
- Are standby load or seat availability indicators needed, and is there a legitimate source for them?

## Stack and layout

TypeScript on Node 20+ (ESM), `luxon` for time zones, `vitest` for tests, `tsx` to run.

```
src/types.ts              Flight, RouteInfo, FlightDataSource interface
src/search.ts             Pure pairing logic + findRoutes() hub-and-spoke orchestration
src/stations.ts           IATA ↔ ICAO for airports and airlines, station → IANA zone
src/data/                 Generated code tables (npm run build-codes; see its README)
src/http.ts               PoliteFetcher: file cache, 1 req/s queue, robots.txt, auth headers
src/sources/opensky.ts    OpenSky adapter: routes, projected flights, OAuth2
src/sources/memory.ts     In-memory source for tests and --demo
src/sources/sample.ts     Made-up demo schedules
src/whitelist.ts          Airline whitelist, saved to ~/.zed-routes/settings.json (ZED_SETTINGS overrides)
src/cli.ts, src/format.ts CLI
scripts/build-codes.ts    Regenerates src/data/ from open datasets
test/                     vitest tests (OpenSky fixtures in test/fixtures/opensky/)
```

Commands:

- `npm test`, `npm run typecheck`
- `npm run zed -- whitelist set AC,LH,UA`
- `npm run zed -- search --from LHR --to YVR --date 2026-11-02 [--demo]`
  (needs `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` unless `--demo`)
- `NODE_USE_ENV_PROXY=1 npm run build-codes` to refresh the code tables

In a cloud session behind the egress proxy, Node's `fetch` needs
`NODE_USE_ENV_PROXY=1` to use `HTTPS_PROXY`.

## Conventions

- Keep the routing/search logic **pure and separate** from data fetching and UI,
  so it can be unit-tested with fixture schedules.
- Write tests for the edge cases: time zones, date-line crossing, overnight
  connections, connections that are too tight, and codeshare (operating vs.
  marketing) filtering.
- Never commit API keys. Load them from environment variables.
