import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { walk } from "./inventory.js";

const TEXT = new Set([".js", ".css", ".html", ".json", ".rsc", ".meta", ".txt", ".webmanifest"]);
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const digest = (value, seed) => createHash("sha256").update(`${seed}\0${VERSION}\0${value}`).digest("base64url").replace(/[^a-z0-9]/gi, "").toLowerCase();

const isAsset = (rel) => !basename(rel).startsWith("_") && /(?:^|\/)static\//.test(rel) && !/(?:^|\/)static\/media\//.test(rel) && [".js", ".css"].includes(extname(rel));

function plan(root, seed) {
  const renames = new Map();
  for (const rel of walk(root)) {
    if (!isAsset(rel)) continue;
    const ext = extname(rel);
    const old = basename(rel);
    const next = `${digest(old, seed).slice(0, 13)}${ext}`;
    renames.set(old, next);
    renameSync(join(root, rel), join(root, dirname(rel), next));
  }
  const idPath = join(root, "BUILD_ID");
  if (existsSync(idPath)) {
    const old = readFileSync(idPath, "utf8").trim();
    if (old.length < 8) return renames;
    const next = digest(old, seed).slice(0, 21);
    const staticDir = join(root, "static", old);
    if (existsSync(staticDir)) renameSync(staticDir, join(root, "static", next));
    renames.set(old, next);
  }
  return renames;
}

export function renameAssets(root, seed) {
  const renames = plan(root, seed);
  if (!renames.size) return renames;
  const pattern = new RegExp(`(?<![\\w-])(?:${[...renames.keys()].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`, "g");
  for (const rel of walk(root)) {
    if (!TEXT.has(extname(rel)) && basename(rel) !== "BUILD_ID") continue;
    const path = join(root, rel);
    const text = readFileSync(path, "utf8");
    const next = text.replace(pattern, (match) => renames.get(match) ?? match);
    if (next !== text) writeFileSync(path, next);
  }
  return renames;
}
