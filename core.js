/*
  STL Heightmap core: STL parsing, z-buffer rasterizing, PNG encoding.
  Runs in a browser worker and in Node (for tests). MIT License.
*/
(function (root) {
  "use strict";

  // ---------- STL parsing ----------

  function isBinarySTL(buf) {
    if (buf.byteLength < 84) return false;
    const n = new DataView(buf).getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) return true;
    // Some exporters write "solid" in binary headers; fall back to a text sniff.
    const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(512, buf.byteLength)));
    return !/^\s*solid[\s\S]*facet/.test(head);
  }

  // Returns Float32Array of 9 floats per triangle.
  function parseSTL(buf) {
    if (isBinarySTL(buf)) {
      const dv = new DataView(buf);
      const n = dv.getUint32(80, true);
      if (84 + n * 50 > buf.byteLength) throw new Error("Truncated binary STL");
      const out = new Float32Array(n * 9);
      let o = 84;
      for (let i = 0; i < n; i++) {
        o += 12; // skip normal
        for (let k = 0; k < 9; k++) { out[i * 9 + k] = dv.getFloat32(o, true); o += 4; }
        o += 2; // attribute bytes
      }
      return out;
    }
    const text = new TextDecoder().decode(new Uint8Array(buf));
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    const v = [];
    let m;
    while ((m = re.exec(text))) v.push(+m[1], +m[2], +m[3]);
    if (v.length === 0 || v.length % 9) throw new Error("Not a valid STL file");
    return new Float32Array(v);
  }

  // ---------- Orientation ----------
  // Map model coords to (u, v, h): u/v are image axes, h is height toward the viewer.
  const VIEWS = {
    top:   (x, y, z) => [x, y, z],     // looking down -Z
    front: (x, y, z) => [x, z, -y],    // looking from -Y toward +Y
    side:  (x, y, z) => [y, z, x],     // looking from +X toward -X
  };

  // ---------- Rasterize ----------
  // opts: {view, resolution (longest side px), offset (0..100 percent), invert}
  // Returns {width, height, heights: Float32Array (NaN = empty), bounds}
  function rasterize(tris, opts, onProgress) {
    const map = VIEWS[opts.view] || VIEWS.top;
    const n = tris.length / 9;
    const P = new Float32Array(tris.length);
    let minU = Infinity, minV = Infinity, minH = Infinity;
    let maxU = -Infinity, maxV = -Infinity, maxH = -Infinity;
    for (let i = 0; i < tris.length; i += 3) {
      const [u, v, h] = map(tris[i], tris[i + 1], tris[i + 2]);
      P[i] = u; P[i + 1] = v; P[i + 2] = h;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
      if (h < minH) minH = h; if (h > maxH) maxH = h;
    }
    if (!isFinite(minU)) throw new Error("STL has no triangles");
    const spanU = maxU - minU || 1e-9, spanV = maxV - minV || 1e-9;
    const res = Math.max(16, Math.min(16384, opts.resolution | 0 || 1024));
    const scale = (res - 1) / Math.max(spanU, spanV);
    const W = Math.max(1, Math.round(spanU * scale) + 1);
    const H = Math.max(1, Math.round(spanV * scale) + 1);
    const zbuf = new Float32Array(W * H).fill(-Infinity);

    const step = Math.max(1, Math.floor(n / 100));
    for (let t = 0; t < n; t++) {
      const b = t * 9;
      // pixel space; image row 0 is the top, so flip v
      const x0 = (P[b] - minU) * scale,     y0 = (maxV - P[b + 1]) * scale, h0 = P[b + 2];
      const x1 = (P[b + 3] - minU) * scale, y1 = (maxV - P[b + 4]) * scale, h1 = P[b + 5];
      const x2 = (P[b + 6] - minU) * scale, y2 = (maxV - P[b + 7]) * scale, h2 = P[b + 8];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (Math.abs(area) < 1e-12) {
        // edge-on triangle: still stamp its vertices so thin walls are not lost
        for (const [px, py, ph] of [[x0, y0, h0], [x1, y1, h1], [x2, y2, h2]]) {
          const ix = Math.round(px), iy = Math.round(py);
          if (ix >= 0 && iy >= 0 && ix < W && iy < H && ph > zbuf[iy * W + ix]) zbuf[iy * W + ix] = ph;
        }
        continue;
      }
      const inv = 1 / area;
      for (let py = by0; py <= by1; py++) {
        for (let px = bx0; px <= bx1; px++) {
          const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
          const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const h = w0 * h0 + w1 * h1 + w2 * h2;
          const k = py * W + px;
          if (h > zbuf[k]) zbuf[k] = h;
        }
      }
      if (onProgress && t % step === 0) onProgress(t / n);
    }

    // Depth range from visible surfaces only, so hidden back faces don't waste gray levels.
    const heights = new Float32Array(W * H);
    let visMin = Infinity, visMax = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const z = zbuf[i];
      if (z === -Infinity) { heights[i] = NaN; continue; }
      heights[i] = z;
      if (z < visMin) visMin = z;
      if (z > visMax) visMax = z;
    }
    if (!isFinite(visMin)) { visMin = minH; visMax = maxH; }
    return { width: W, height: H, heights, bounds: { minH: visMin, maxH: visMax, spanU, spanV, scale } };
  }

  // Normalize heights to 0..1 grayscale. Empty pixels are 0 (black).
  // offset: percent of range reserved above black for the lowest model point.
  function normalize(r, opts) {
    const { minH, maxH } = r.bounds;
    const range = maxH - minH || 1;
    const off = Math.max(0, Math.min(100, +opts.offset || 0)) / 100;
    const out = new Float32Array(r.heights.length);
    for (let i = 0; i < out.length; i++) {
      const h = r.heights[i];
      if (h !== h) {
        // background: "carve" = deepest (black), "keep" = untouched (white)
        const bg = opts.background === "keep" ? 1 : 0;
        out[i] = opts.invert ? 1 - bg : bg;
        continue;
      }
      let g = off + (1 - off) * (h - minH) / range;
      if (opts.invert) g = 1 - g;
      out[i] = g;
    }
    return out;
  }

  // ---------- PNG (grayscale, 8 or 16 bit) ----------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  // deflate: async (data: Uint8Array) => Uint8Array in zlib format
  // pxPerMm (optional): writes a pHYs chunk so LightBurn and others import at true size.
  async function encodePNG(gray, W, H, bits, deflate, pxPerMm) {
    const bpp = bits === 16 ? 2 : 1;
    const stride = W * bpp + 1;
    const raw = new Uint8Array(stride * H);
    const max = bits === 16 ? 65535 : 255;
    for (let y = 0; y < H; y++) {
      raw[y * stride] = 0; // filter: none
      for (let x = 0; x < W; x++) {
        const v = Math.round(Math.max(0, Math.min(1, gray[y * W + x])) * max);
        const o = y * stride + 1 + x * bpp;
        if (bpp === 2) { raw[o] = v >> 8; raw[o + 1] = v & 255; } else raw[o] = v;
      }
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, W); dv.setUint32(4, H);
    ihdr[8] = bits; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = await deflate(raw);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
    if (pxPerMm > 0) {
      const phys = new Uint8Array(9);
      const ppm = Math.round(pxPerMm * 1000); // pixels per metre
      new DataView(phys.buffer).setUint32(0, ppm);
      new DataView(phys.buffer).setUint32(4, ppm);
      phys[8] = 1; // unit: metre
      parts.push(chunk("pHYs", phys));
    }
    parts.push(chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)));
    const total = parts.reduce((s, p) => s + p.length, 0);
    const png = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { png.set(p, o); o += p.length; }
    return png;
  }

  async function browserDeflate(data) {
    const cs = new CompressionStream("deflate"); // zlib-wrapped, as PNG requires
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const api = { parseSTL, rasterize, normalize, encodePNG, browserDeflate, VIEWS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.STLHeightmap = api;
})(typeof self !== "undefined" ? self : this);
