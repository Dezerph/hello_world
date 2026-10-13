import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowed, PoliteFetcher, RobotsDisallowedError } from "../src/http.js";

const UA = "zed-routes/0.1";

function fakeNet(pages: Record<string, string>) {
  let clock = 0;
  const requests: { url: string; at: number }[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    requests.push({ url, at: clock });
    const body = pages[url];
    return new Response(body ?? "not found", { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;
  return {
    requests,
    opts: { fetchImpl, now: () => clock, sleep: async (ms: number) => void (clock += ms) },
  };
}

describe("PoliteFetcher", () => {
  it("throttles requests, caches responses and checks robots.txt", async () => {
    const net = fakeNet({
      "https://example.com/robots.txt": "User-agent: *\nDisallow: /private\n",
      "https://example.com/a": "A",
      "https://example.com/b": "B",
    });
    const fetcher = new PoliteFetcher({ cacheDir: await mkdtemp(join(tmpdir(), "zed-")), userAgent: UA, minIntervalMs: 1000, ...net.opts });

    expect(await Promise.all([fetcher.get("https://example.com/a", 60_000), fetcher.get("https://example.com/b", 60_000)])).toEqual(["A", "B"]);
    expect(await fetcher.get("https://example.com/a", 60_000)).toBe("A"); // cached

    const urls = net.requests.map((r) => r.url);
    expect(urls.filter((u) => u.endsWith("/a"))).toHaveLength(1);
    const times = net.requests.map((r) => r.at);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000);

    await expect(fetcher.get("https://example.com/private/x", 60_000)).rejects.toThrow(RobotsDisallowedError);
  });
  it("does not crawl when robots.txt is refused", async () => {
    const net = fakeNet({});
    const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    const fetcher = new PoliteFetcher({
      cacheDir: await mkdtemp(join(tmpdir(), "zed-")), userAgent: UA, minIntervalMs: 0, ...net.opts, fetchImpl,
    });
    await expect(fetcher.get("https://example.com/a", 60_000)).rejects.toThrow(/HTTP 403/);
  });
});

describe("isAllowed", () => {
  const robots = `
User-agent: *
Disallow: /search
Allow: /search/public
Disallow: /*.json$

User-agent: zed-routes
Disallow: /blocked-for-us
`;
  const u = (p: string) => new URL(`https://example.com${p}`);

  it("uses the most specific matching rule", () => {
    expect(isAllowed(robots, u("/search/x"), "other-bot/1")).toBe(false);
    expect(isAllowed(robots, u("/search/public/x"), "other-bot/1")).toBe(true);
    expect(isAllowed(robots, u("/data.json"), "other-bot/1")).toBe(false);
    expect(isAllowed(robots, u("/data.json?x=1"), "other-bot/1")).toBe(true);
    expect(isAllowed(robots, u("/YYZ/destinations"), "other-bot/1")).toBe(true);
  });

  it("prefers a group naming our user agent", () => {
    expect(isAllowed(robots, u("/blocked-for-us"), UA)).toBe(false);
    expect(isAllowed(robots, u("/search/x"), UA)).toBe(true);
  });

  it("allows everything when robots.txt is empty", () => {
    expect(isAllowed("", u("/anything"), UA)).toBe(true);
  });
});
