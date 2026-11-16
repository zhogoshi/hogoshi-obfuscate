import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const SKIP_DIRS = new Set(["cache", "node_modules", "trace", ".vercel", "dev", "types"]);
const RUNTIME_FILE = /(?:^|\/)(?:webpack|turbopack|polyfills|framework|main-app|main)[-.]/;
const KINDS = { ".css": "css", ".html": "html", ".rsc": "flight", ".map": "map" };

export function classify(rel) {
  const ext = extname(rel);
  if (ext === ".js") {
    if (!/(?:^|\/)static\//.test(rel)) return "server-js";
    return RUNTIME_FILE.test(rel) ? "runtime-js" : "client-js";
  }
  if (ext === ".json") return /manifest/i.test(rel) ? "manifest" : "json";
  return KINDS[ext] ?? "other";
}

export function walk(root, dir = root, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(root, path, files);
    } else {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return files;
}

export function inventory(root) {
  return walk(root).map((rel) => {
    const content = readFileSync(join(root, rel));
    return { path: rel, kind: classify(rel), size: content.length, hash: createHash("sha256").update(content).digest("hex").slice(0, 16) };
  });
}

export function measure(root) {
  const totals = {};
  for (const rel of walk(root)) {
    const kind = classify(rel);
    if (!["client-js", "runtime-js", "css", "html"].includes(kind)) continue;
    const content = readFileSync(join(root, rel));
    const total = (totals[kind] ??= { files: 0, raw: 0, gzip: 0, brotli: 0 });
    total.files += 1;
    total.raw += content.length;
    total.gzip += gzipSync(content, { level: 9 }).length;
    total.brotli += brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length;
  }
  return totals;
}
