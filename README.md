# zed-routes

Finds one-layover standby (ZED) routings between two stations, using only the
airlines you're allowed to fly on: Air Canada plus the airlines in `oal.js`, its
ZED agreement list. See `CLAUDE.md` for the full project context.

**Status:** proof of concept. The search, OAL whitelist and fetcher are
tested. Real schedules come from [AeroDataBox](https://aerodatabox.com) (via
RapidAPI): set `AERODATABOX_API_KEY`. The adapter is tested only against
hand-written fixtures, because the API was not reachable when it was built, so
check it against real responses first. Use `--demo` to try the search on
made-up schedules.

```sh
npm install
npm run zed -- oal                              # airlines you can fly, with fare levels
npm run zed -- search --from LHR --to YVR --date 2026-11-02 --demo
npm run zed -- search --from LHR --to YVR --date 2026-11-02 --traveller spouse --business --demo

# Someone at another airline: import their OAL file and switch to it
npm run zed -- oal import their-oal.js --name jane --home WS
npm run zed -- oal use jane
npm test
```
