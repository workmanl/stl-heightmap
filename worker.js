/* Runs the conversion off the main thread. MIT License. */
importScripts("core.js");

self.onmessage = async (e) => {
  const { buffer, opts } = e.data;
  try {
    const S = self.STLHeightmap;
    const tris = S.parseSTL(buffer);
    const r = S.rasterize(tris, opts, (p) => self.postMessage({ type: "progress", value: p }));
    const gray = S.normalize(r, opts);
    // STL units are treated as mm (the common default), so scale is px per mm.
    const png = await S.encodePNG(gray, r.width, r.height, opts.bits, S.browserDeflate, r.bounds.scale);
    const preview = new Uint8ClampedArray(r.width * r.height * 4);
    for (let i = 0; i < gray.length; i++) {
      const v = Math.round(gray[i] * 255);
      preview[i * 4] = preview[i * 4 + 1] = preview[i * 4 + 2] = v;
      preview[i * 4 + 3] = 255;
    }
    self.postMessage({
      type: "done", png, preview, width: r.width, height: r.height,
      triangles: tris.length / 9,
      size: { u: r.bounds.spanU, v: r.bounds.spanV, h: r.bounds.maxH - r.bounds.minH },
    }, [png.buffer, preview.buffer]);
  } catch (err) {
    self.postMessage({ type: "error", message: err.message || String(err) });
  }
};
