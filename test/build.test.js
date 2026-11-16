import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "../src/build.js";

const layout = (html) => {
  const root = join(mkdtempSync(join(tmpdir(), "hg-")), ".next");
  for (const dir of ["static/chunks", "server"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "BUILD_ID"), "id");
  writeFileSync(join(root, "static/chunks/a.js"), "function hello(){ const value = 1; return value }\nhello();\n//# sourceMappingURL=a.js.map\n");
  writeFileSync(join(root, "static/chunks/a.js.map"), "{}");
  writeFileSync(join(root, "static/chunks/a.css"), ".flex { display: flex; }\n");
  writeFileSync(join(root, "server/page.html"), html);
  return root;
};

test("server-build output has no maps and keeps the source untouched", async () => {
  const root = layout('<link href="/_next/static/chunks/a.css"/><div class="flex"> x </div>');
  const out = join(root, "..", "out");
  const maps = join(root, "..", "maps");
  await build(root, { mode: "server-build", out, mapsOut: maps });
  assert.ok(existsSync(join(root, "static/chunks/a.js.map")));
  assert.ok(!existsSync(join(out, "static/chunks/a.js.map")));
  assert.ok(existsSync(join(maps, "static/chunks/a.js.map")));
  assert.ok(!readFileSync(join(out, "static/chunks/a.js"), "utf8").includes("sourceMappingURL"));
});

test("the release gate rejects a missing asset and publishes nothing", async () => {
  const root = layout('<script src="/_next/static/chunks/missing.js"></script>');
  const out = join(root, "..", "out");
  await assert.rejects(build(root, { mode: "server-build", out }), /missing asset/);
  assert.ok(!existsSync(out));
  assert.ok(!existsSync(`${root}.staging`));
});

test("a mode and one output target are required", async () => {
  const root = layout("<p></p>");
  await assert.rejects(build(root, { out: join(root, "..", "o") }), /--mode/);
  await assert.rejects(build(root, { mode: "server-build" }), /exactly one/);
});

test("hardened code behaves like the original", async () => {
  const source = `
    function run(items, config) {
      const out = [];
      let total = 0;
      for (const item of items) {
        if (item % 2 === 0) total += item * 2;
        else if (item % 3 === 0) total -= item;
        else out.push(config?.format?.(item) ?? String(item));
      }
      const counter = (() => { let n = 0; return () => ++n; })();
      try { if (total > 100) throw new Error("big"); } catch (error) { out.push(error.message); } finally { out.push("done" + counter() + counter()); }
      return { total, out, label: config?.missing?.(1), text: \`n=\${total}\` };
    }
    globalThis.result = [run([1, 2, 3, 4, 5, 6, 7, 60], { format: (value) => "#" + value }), run([], undefined)];
  `;
  const root = layout("<p></p>");
  writeFileSync(join(root, "static/chunks/a.js"), source);
  const expected = new Function(`${source}; return globalThis.result;`)();
  const out = join(root, "..", "behaviour");
  await build(root, { mode: "server-build", out, seed: "t" });
  const text = readFileSync(join(out, "static/chunks/a.js"), "utf8");
  assert.ok(!text.includes('"#"'));
  const actual = new Function(`${text}; return globalThis.result;`)();
  assert.deepEqual(actual, expected);
});

test("escaped spaces become plain spaces without touching escaped backslashes", async () => {
  const { unescapeSpaces } = await import("../src/js.js");
  const out = unescapeSpaces(String.raw`a=['x\x20\x20y','\\x20','\x41'];`);
  assert.equal(out, String.raw`a=['x  y','\\x20','\x41'];`);
});

test("marked functions are virtualized inside a build", async () => {
  const root = layout("<p></p>");
  writeFileSync(
    join(root, "static/chunks/a.js"),
    'const protect=(t,f)=>f;const calc=protect("hogoshi:vm",function(a,b){let s=0;for(let i=0;i<a;i++)s+=i*b;return s});globalThis.result=calc(5,3);',
  );
  const out = join(root, "..", "vm");
  const report = await build(root, { mode: "server-build", out, seed: "t" });
  assert.equal(report.virtualized[0].functions, 1);
  const text = readFileSync(join(out, "static/chunks/a.js"), "utf8");
  assert.ok(!text.includes("hogoshi:vm"));
  assert.equal(new Function(`${text}; return globalThis.result;`)(), 30);
});
