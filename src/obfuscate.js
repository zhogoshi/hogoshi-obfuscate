import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

const TEXT_EXTENSIONS = new Set([".js", ".css", ".html", ".rsc"]);
const SKIP_DIRS = new Set(["cache", "node_modules", "trace"]);
const RUNTIME_FILE = /(?:^|\/)(?:webpack|turbopack|polyfills|framework|main-app|main)[-.]/;
const RESERVED_CLASS = new Set(["dark", "light", "container"]);
const RESERVED_CLASS_PREFIX = ["hljs-", "language-"];
const RESERVED_VAR_PREFIX = ["--tw-", "--next"];

function walk(dir, files = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(path, files);
      continue;
    }
    if (TEXT_EXTENSIONS.has(extname(path))) files.push(path);
  }
  return files;
}

function token(prefix, seed, salt) {
  const digest = createHash("sha256").update(`${prefix}:${seed}:${salt}`).digest("hex");
  return `_${prefix}${digest.slice(0, 10)}`;
}

function variableName(seed, salt) {
  return `--v${createHash("sha256").update(`v:${seed}:${salt}`).digest("hex").slice(0, 10)}`;
}

function cssEscape(value) {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function shouldMangleClass(name) {
  if (!name || name.startsWith("_") || name.includes("${")) return false;
  if (RESERVED_CLASS.has(name) || !/[-:/.[\]0-9]/.test(name)) return false;
  return !RESERVED_CLASS_PREFIX.some((prefix) => name.startsWith(prefix));
}

function unescapeCssIdent(value) {
  return value.replace(/\\(.)/g, "$1");
}

function collectClasses(cssFiles) {
  const names = new Set();
  const pattern = /\.((?:\\.|[A-Za-z0-9_-])+)/g;
  for (const file of cssFiles) {
    const css = readFileSync(file, "utf8");
    for (const match of css.matchAll(pattern)) {
      const name = unescapeCssIdent(match[1]);
      if (shouldMangleClass(name)) names.add(name);
    }
  }
  return [...names].sort((left, right) => right.length - left.length);
}

function collectSlots(files) {
  const names = new Set();
  const pattern = /data-slot=(?:"([^"]+)"|'([^']+)'|([A-Za-z][\w-]*))/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const name = match[1] || match[2] || match[3];
      if (name && !name.includes("${") && !name.startsWith("_")) names.add(name);
    }
  }
  return [...names].sort((left, right) => right.length - left.length);
}

function collectVariables(cssFiles) {
  const names = new Set();
  const pattern = /(?<![\w-])(--[A-Za-z][\w-]*)/g;
  for (const file of cssFiles) {
    const css = readFileSync(file, "utf8");
    for (const match of css.matchAll(pattern)) {
      const name = match[1];
      if (RESERVED_VAR_PREFIX.some((prefix) => name.startsWith(prefix))) continue;
      names.add(name);
    }
  }
  return [...names].sort((left, right) => right.length - left.length);
}

function replaceBounded(source, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g"), to);
}

function isClientScript(file, root) {
  const path = relative(root, file).replaceAll("\\", "/");
  return path.startsWith("static/chunks/") && path.endsWith(".js") && !RUNTIME_FILE.test(path);
}

function obfuscateScript(code) {
  return JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    simplify: true,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    transformObjectKeys: false,
    stringArray: true,
    stringArrayThreshold: 0.75,
    stringArrayEncoding: ["base64"],
    stringArrayWrappersCount: 1,
    stringArrayWrappersType: "function",
    rotateStringArray: true,
    splitStrings: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
    unicodeEscapeSequence: false,
    reservedNames: ["^webpack", "^__webpack", "^__next", "^next"],
    reservedStrings: ["/_next/", "__NEXT_DATA__", "next/dist"],
  }).getObfuscatedCode();
}

export async function obfuscateBuild(root) {
  const files = walk(root);
  const cssFiles = files.filter((file) => file.endsWith(".css"));
  const salt = randomBytes(8).toString("hex");
  const classes = new Map(collectClasses(cssFiles).map((name) => [name, token("c", name, salt)]));
  const slots = new Map(collectSlots(files).map((name) => [name, token("s", name, salt)]));
  const variables = new Map(collectVariables(cssFiles).map((name) => [name, variableName(name, salt)]));
  let scripts = 0;

  for (const file of files) {
    let text = readFileSync(file, "utf8");
    const original = text;
    if (file.endsWith(".css")) {
      for (const [name, mangled] of classes) {
        text = text.split(`.${cssEscape(name)}`).join(`.${cssEscape(mangled)}`);
      }
    } else {
      for (const [name, mangled] of classes) text = replaceBounded(text, name, mangled);
    }
    for (const [name, mangled] of variables) text = text.split(name).join(mangled);
    for (const [name, mangled] of slots) {
      text = text.split(`data-slot="${name}"`).join(`data-slot="${mangled}"`);
      text = text.split(`data-slot='${name}'`).join(`data-slot='${mangled}'`);
      text = text.split(`data-slot=${name}`).join(`data-slot=${mangled}`);
    }
    if (isClientScript(file, root)) {
      try {
        text = obfuscateScript(text);
        scripts += 1;
        try {
          rmSync(`${file}.map`);
        } catch {
          /* no map */
        }
      } catch (error) {
        console.error(`skip script ${relative(root, file)}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    if (text !== original) writeFileSync(file, text);
  }

  return { files: files.length, classes: classes.size, variables: variables.size, slots: slots.size, scripts };
}
