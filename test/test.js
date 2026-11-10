// node test/test.js : builds a pyramid STL (binary + ASCII), checks the heightmap and PNG.
const S = require("../core.js");
const zlib = require("zlib");
const fs = require("fs");
const assert = require("assert");

// square pyramid: base 40x20 mm at z=0, apex at (20,10,10)
const A = [20, 10, 10], b = [[0,0,0],[40,0,0],[40,20,0],[0,20,0]];
const tris = [];
for (let i = 0; i < 4; i++) tris.push([b[i], b[(i + 1) % 4], A]);
tris.push([b[0], b[2], b[1]], [b[0], b[3], b[2]]);

function binary() {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.flat().forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}
function ascii() {
  let s = "solid p\n";
  for (const t of tris) s += "facet normal 0 0 0\nouter loop\n" + t.map(v => "vertex " + v.join(" ")).join("\n") + "\nendloop\nendfacet\n";
  return new TextEncoder().encode(s + "endsolid p\n").buffer;
}
const deflate = async (d) => new Uint8Array(zlib.deflateSync(d));

(async () => {
  for (const [name, buf] of [["binary", binary()], ["ascii", ascii()]]) {
    const t = S.parseSTL(buf);
    assert.strictEqual(t.length / 9, 6, name + " triangle count");
    const r = S.rasterize(t, { view: "top", resolution: 401 });
    assert.strictEqual(r.width, 401); assert.strictEqual(r.height, 201);
    const g = S.normalize(r, { offset: 0 });
    const c = g[100 * 401 + 200];
    assert(c > 0.98, name + " apex should be white, got " + c);
    assert(g[0] < 0.02, name + " corner should be dark");
    const mid = g[100 * 401 + 100]; // halfway from edge to apex along x
    assert(Math.abs(mid - 0.5) < 0.03, name + " slope midpoint ~0.5, got " + mid);
    console.log(name + " ok: apex", c.toFixed(3), "mid", mid.toFixed(3), "scale px/mm", r.bounds.scale);
  }
  // front view: pyramid seen from -Y is a triangle; width 40, height 10
  const t = S.parseSTL(binary());
  const f = S.rasterize(t, { view: "front", resolution: 401 });
  assert.strictEqual(f.width, 401); assert.strictEqual(f.height, 101);
  assert(isNaN(f.heights[0]), "front top-left corner is empty (above the slope)");
  // background modes with a padded model: front view has empty corners
  const gk = S.normalize(f, { background: "keep" });
  const gc = S.normalize(f, { background: "carve", offset: 20 });
  assert.strictEqual(gk[0], 1); assert.strictEqual(gc[0], 0);
  const minModel = Math.min(...Array.from(gc).filter((v, i) => !isNaN(f.heights[i])));
  assert(Math.abs(minModel - 0.2) < 1e-6, "offset lifts lowest model point to 20%");

  const g = S.normalize(S.rasterize(t, { view: "top", resolution: 401 }), {});
  for (const bits of [8, 16]) {
    const png = await S.encodePNG(g, 401, 201, bits, deflate, 10);
    fs.writeFileSync(`test/out-${bits}.png`, png);
  }
  console.log("all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
