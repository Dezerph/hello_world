import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FetcherOptions {
  cacheDir: string;
  userAgent: string;
  /** Minimum gap between network requests, across all URLs. */
  minIntervalMs: number;
  /** Check robots.txt before fetching (default true). Turn off only for documented APIs. */
  respectRobots?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GetOptions {
  /** Extra request headers, e.g. auth. Only called when a network request is made. */
  headers?: () => Promise<Record<string, string>>;
  /** Treat HTTP 404 as success with this body (and cache it). For APIs that 404 on "no results". */
  notFoundBody?: string;
}

export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string) {
    super(`robots.txt disallows fetching ${url}`);
  }
}

export class HttpError extends Error {
  constructor(public readonly url: string, public readonly status: number) {
    super(`GET ${url} failed with HTTP ${status}`);
  }
}

interface CacheEntry {
  url: string;
  fetchedAt: number;
  body: string;
}

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Polite HTTP GET: file cache, one request at a time with a minimum interval,
 * honest User-Agent, and robots.txt checks.
 */
export class PoliteFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = -Infinity;

  constructor(private readonly opts: FetcherOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async get(url: string, ttlMs: number, options: GetOptions = {}): Promise<string> {
    const cached = await this.readCache(url);
    if (cached && this.now() - cached.fetchedAt < ttlMs) return cached.body;

    if (this.opts.respectRobots ?? true) {
      const robots = await this.getRobots(new URL(url).origin);
      if (!isAllowed(robots, new URL(url), this.opts.userAgent)) throw new RobotsDisallowedError(url);
    }

    const res = await this.throttled(url, options.headers);
    let body: string;
    if (res.status === 404 && options.notFoundBody !== undefined) body = options.notFoundBody;
    else if (!res.ok) throw new HttpError(url, res.status);
    else body = await res.text();
    await this.writeCache({ url, fetchedAt: this.now(), body });
    return body;
  }

  private async getRobots(origin: string): Promise<string> {
    const url = `${origin}/robots.txt`;
    const cached = await this.readCache(url);
    if (cached && this.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached.body;
    const res = await this.throttled(url);
    // No robots.txt (404 etc.) means everything is allowed. Being refused (401/403)
    // or a server error means don't crawl.
    if (res.status === 401 || res.status === 403 || res.status >= 500) throw new HttpError(url, res.status);
    const body = res.ok ? await res.text() : "";
    await this.writeCache({ url, fetchedAt: this.now(), body });
    return body;
  }

  /** Serialises network requests and spaces them `minIntervalMs` apart. */
  private throttled(url: string, extraHeaders?: GetOptions["headers"]): Promise<Response> {
    const run = async () => {
      const headers = { ...(await extraHeaders?.()), "User-Agent": this.opts.userAgent };
      const wait = this.lastRequestAt + this.opts.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      try {
        return await this.fetchImpl(url, { headers });
      } catch (e) {
        const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : String(e);
        throw new Error(`Could not reach ${url}: ${cause}`, { cause: e });
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private cachePath(url: string): string {
    return join(this.opts.cacheDir, `${createHash("sha256").update(url).digest("hex")}.json`);
  }

  private async readCache(url: string): Promise<CacheEntry | undefined> {
    try {
      return JSON.parse(await readFile(this.cachePath(url), "utf8")) as CacheEntry;
    } catch {
      return undefined;
    }
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    await mkdir(this.opts.cacheDir, { recursive: true });
    await writeFile(this.cachePath(entry.url), JSON.stringify(entry));
  }
}

/**
 * Minimal robots.txt evaluation: picks the group for our product token (or `*`),
 * longest matching Allow/Disallow rule wins, Allow wins ties. Supports `*` and `$`.
 */
export function isAllowed(robotsTxt: string, url: URL, userAgent: string): boolean {
  const token = userAgent.split("/")[0]!.toLowerCase();
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;

  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const group =
    groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a))) ??
    groups.find((g) => g.agents.includes("*"));
  if (!group) return true;

  const path = url.pathname + url.search;
  let best: { allow: boolean; length: number } | undefined;
  for (const rule of group.rules) {
    const regex = new RegExp(
      "^" + rule.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"),
    );
    if (!regex.test(path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best?.allow ?? true;
}
