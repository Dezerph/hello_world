import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOal, type OalAirline } from "./oal.js";
import type { CarrierCode } from "./types.js";

/**
 * OAL profiles: which OAL file the search uses. The built-in profile is the
 * Air Canada OAL list in the repo's oal.js. Other users import their own file,
 * which is saved (as parsed data, never as code) under a name.
 */

export interface OalProfile {
  name: string;
  /** The user's own airline first, then its regionals. Allowed for everyone, on staff travel. */
  home: CarrierCode[];
  airlines: OalAirline[];
  warnings: string[];
}

export const BUILTIN_PROFILE = "ac";
/** Air Canada, Jazz (Air Canada Express) and Air Canada Rouge. */
export const BUILTIN_HOME: CarrierCode[] = ["AC", "QK", "RV"];
const BUILTIN_FILE = fileURLToPath(new URL("../oal.js", import.meta.url));

/** Where the user's settings live. Override with ZED_SETTINGS. */
export const settingsPath = () => process.env.ZED_SETTINGS ?? join(homedir(), ".zed-routes", "settings.json");
const profilesDir = () => join(dirname(settingsPath()), "oal");
const profilePath = (name: string) => join(profilesDir(), `${name}.json`);

interface Settings {
  activeOal?: string;
}

/** Validates and normalises airline codes: 2 characters, letters/digits, upper case, unique, in the given order. */
export function parseCarrierCodes(input: string | string[]): CarrierCode[] {
  const parts = (Array.isArray(input) ? input : [input]).flatMap((s) => s.split(/[\s,]+/)).filter(Boolean);
  const codes = parts.map((p) => p.toUpperCase());
  const bad = codes.filter((c) => !/^[A-Z0-9]{2}$/.test(c));
  if (bad.length) throw new Error(`Not valid 2-character airline codes: ${bad.join(", ")}`);
  return [...new Set(codes)];
}

function checkName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(n)) throw new Error(`Profile names use letters, digits, - and _ (got "${name}").`);
  return n;
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8")) as Settings;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
}

export async function loadProfile(name: string): Promise<OalProfile> {
  const n = checkName(name);
  if (n === BUILTIN_PROFILE) {
    const { airlines, warnings } = parseOal(await readFile(BUILTIN_FILE, "utf8"));
    return { name: n, home: BUILTIN_HOME, airlines, warnings };
  }
  try {
    return JSON.parse(await readFile(profilePath(n), "utf8")) as OalProfile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No OAL profile called "${n}". See: npm run zed -- oal list`);
    throw e;
  }
}

export async function activeProfileName(): Promise<string> {
  return (await readSettings()).activeOal ?? BUILTIN_PROFILE;
}

export async function loadActiveProfile(): Promise<OalProfile> {
  return loadProfile(await activeProfileName());
}

/** Parse an OAL file and save it as a profile. Does not switch to it. */
export async function importProfile(file: string, name: string, home: CarrierCode[]): Promise<OalProfile> {
  const n = checkName(name);
  if (n === BUILTIN_PROFILE) throw new Error(`"${BUILTIN_PROFILE}" is the built-in profile; pick another name.`);
  const { airlines, warnings } = parseOal(await readFile(file, "utf8"));
  const profile: OalProfile = { name: n, home: parseCarrierCodes(home), airlines, warnings };
  await mkdir(profilesDir(), { recursive: true });
  await writeFile(profilePath(n), JSON.stringify(profile, null, 2) + "\n");
  return profile;
}

export async function useProfile(name: string): Promise<void> {
  const n = checkName(name);
  await loadProfile(n); // must exist
  await writeSettings({ ...(await readSettings()), activeOal: n });
}

export async function listProfiles(): Promise<string[]> {
  let files: string[] = [];
  try {
    files = await readdir(profilesDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const imported = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  return [BUILTIN_PROFILE, ...imported.sort()];
}

export async function removeProfile(name: string): Promise<void> {
  const n = checkName(name);
  if (n === BUILTIN_PROFILE) throw new Error("The built-in profile can't be removed.");
  await loadProfile(n); // must exist
  await rm(profilePath(n));
  const settings = await readSettings();
  if (settings.activeOal === n) await writeSettings({ ...settings, activeOal: undefined });
}
