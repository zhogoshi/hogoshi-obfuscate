import assert from "node:assert/strict";
import test from "node:test";
import { virtualize } from "../src/vm/virtualize.js";

const PRELUDE = "const protect = (tag, fn) => fn;";

const same = (body) => {
  const plain = new Function(`${PRELUDE} ${body}`)();
  const { code, count, skipped } = virtualize(`${PRELUDE} ${body}`, "seed");
  assert.deepEqual(skipped, []);
  assert.equal(count, 1);
  assert.ok(!code.includes("hogoshi:vm"));
  assert.deepEqual(new Function(code)(), plain);
};

test("arithmetic, loops, branches, and returns", () => {
  same(`
    const f = protect("hogoshi:vm", function (n, limit) {
      let total = 0, i = 0;
      for (let k = 0; k < n; k++) { if (k % 2 === 0) total += k * 2; else if (k % 3 === 0) { total -= k; continue; } else total ^= k; if (total > limit) break; }
      while (i < 3) i++;
      do { i--; } while (i > 1);
      return total + i + (n > 5 ? 1 : 2) + (n ** 2) + (n << 1) + -n + +"3" + ~n + (!n ? 1 : 0);
    });
    return [f(0, 10), f(7, 100), f(30, 50)];
  `);
});

test("objects, arrays, members, calls, templates, and typeof", () => {
  same(`
    const f = protect("hogoshi:vm", function (a, list) {
      const o = { x: 1, ["y" + a]: 2, z: [1, 2, a] };
      o.x += 4; o.z[1]++; ++o.x; const old = o.z[0]--; delete o.y1;
      const joined = list.map((v) => v * a).join("-");
      const re = /a(b+)/g.exec("xabbb");
      return { o, old, joined, re: re[1], t: typeof missingGlobal + typeof a, s: \`v=\${a}:\${joined}!\`, len: list.length, inn: "x" in o, io: o instanceof Object, seq: (1, 2, 3) };
    });
    return [f(2, [1, 2, 3]), f(0, [])];
  `);
});

test("closures, optional chaining, logic, and try/catch", () => {
  same(`
    const f = protect("hogoshi:vm", (config, values) => {
      let count = 0;
      const bump = () => ++count;
      const adders = [];
      for (var i = 0; i < 3; i++) adders.push((x) => x + i + bump());
      const results = [config?.a?.b, config?.fn?.(2), config.missing?.(), config?.obj.m?.(5), config.a && config.a.b, config.zero || "d", config.nil ?? "n"];
      let caught;
      try { null.x; } catch (e) { caught = e instanceof TypeError; }
      try { throw new Error("boom"); } catch { caught = [caught, "again"]; }
      return [results, adders.map((fn) => fn(10)), count, caught, values.reduce(function (acc, v) { return acc + v; }, 0)];
    });
    return [f({ a: { b: 1 }, fn: (v) => v * 2, obj: { m: (v) => v + 1 }, zero: 0, nil: null }, [1, 2]), f({ obj: {} }, [])];
  `);
});

test("unsupported functions are reported and left alone", () => {
  const { code, count, skipped } = virtualize(`const protect = (t, f) => f; const g = protect("hogoshi:vm", function (xs) { for (const x of xs) {} });`, "s");
  assert.equal(count, 0);
  assert.match(skipped[0], /ForOfStatement/);
  assert.ok(code.includes("for (const x of xs)"));
});
