import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CarrierCode } from "./types.js";

/** Where the user's settings live. Override with ZED_SETTINGS. */
export const settingsPath = () => process.env.ZED_SETTINGS ?? join(homedir(), ".zed-routes", "settings.json");

interface Settings {
  whitelist: CarrierCode[];
}

/** Validates and normalises airline codes: 2 characters, letters/digits, upper case, unique, sorted. */
export function parseCarrierCodes(input: string | string[]): CarrierCode[] {
  const parts = (Array.isArray(input) ? input : [input]).flatMap((s) => s.split(/[\s,]+/)).filter(Boolean);
  const codes = parts.map((p) => p.toUpperCase());
  const bad = codes.filter((c) => !/^[A-Z0-9]{2}$/.test(c));
  if (bad.length) throw new Error(`Not valid 2-character airline codes: ${bad.join(", ")}`);
  return [...new Set(codes)].sort();
}

export async function loadWhitelist(path = settingsPath()): Promise<CarrierCode[]> {
  try {
    const settings = JSON.parse(await readFile(path, "utf8")) as Partial<Settings>;
    return parseCarrierCodes(settings.whitelist ?? []);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function saveWhitelist(codes: CarrierCode[], path = settingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const settings: Settings = { whitelist: parseCarrierCodes(codes) };
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
}
