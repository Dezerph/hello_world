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
- Both segments must be on **operating carriers the user can travel on**: their
  home carrier, or a carrier with a ZED agreement with the home carrier. The two
  segments do **not** have to be on the same airline.
- Leg 2 must depart at least `MCT + buffer` after leg 1 arrives at `X`.
  Defaults are open to change; until decided, use ~90 min for an international
  self-transfer and cap layovers at ~12 h.
- Use the **local time** of each station for display. Use UTC (or tz-aware
  datetimes) for every comparison, because routes cross time zones and the date line.
- The time window filters on leg 1 departure and/or leg 2 arrival.
- Connections that run overnight (leg 2 on the next day) should be supported
  but flagged.
- Sort by total journey time by default.

## Data the app needs

| Data | Purpose | Notes |
|---|---|---|
| Airports | Station picker, time zones | Open datasets exist (e.g. OurAirports + IANA tz) |
| Flight schedules | Building the segments | Source **not decided yet**. Candidates: a schedules API (OAG, Cirium, Aviationstack, AeroDataBox, etc.), or a manually maintained dataset |
| ZED agreements | Filtering by carrier eligibility | Depends on the user's home carrier. Likely a user-editable list of eligible carriers at first, since agreement data is not public |
| MCT per airport | Connection validity | Use a configurable default to start |

Do not scrape airline or staff-travel portals. They usually require staff
credentials and their terms forbid automated access.

## Open questions (decide before building much)

- Tech stack and platform (web app, mobile, or both).
- Schedule data provider: cost, coverage and rate limits.
- How the user sets their home carrier and eligible ZED carriers.
- Should **direct flights** appear alongside the 1-layover routes?
- Will 2-layover routes be needed later? (Design the search so the number of hops can be raised.)
- Are standby load or seat availability indicators needed, and is there a legitimate source for them?

## Conventions

- Keep the routing/search logic **pure and separate** from data fetching and UI,
  so it can be unit-tested with fixture schedules.
- Write tests for the edge cases: time zones, date-line crossing, overnight
  connections, connections that are too tight, and codeshare (operating vs.
  marketing) filtering.
- Never commit API keys. Load them from environment variables.
