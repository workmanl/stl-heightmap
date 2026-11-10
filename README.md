# STL Heightmap

Convert an STL file into a grayscale PNG depth map for laser depth engraving
(LightBurn 3D Sliced mode on fiber/galvo lasers) or 2.5D CNC carving.

**Use it:** https://workmanl.github.io/stl-heightmap/

Everything runs in your browser. Nothing is uploaded.

## Features

- Binary and ASCII STL
- Top, Front or Side view
- 8-bit or 16-bit grayscale PNG (16-bit for more than 256 passes)
- Real-size output: the PNG stores its pixels per mm, so it imports into
  LightBurn at the model's actual width and height (STL units assumed to be mm)
- Background carved away (black) or left untouched (white)
- Depth offset and invert
- Conversion runs in a Web Worker, so large files don't freeze the page

## LightBurn 3D Sliced quick start

1. Model in mm and export STL.
2. Convert here with Invert off. LightBurn engraves dark areas deepest and
   skips pure white, so the top of the model stays untouched.
3. Choose 16-bit if you will run more than 256 passes (LightBurn 2.1+).
4. In LightBurn, import the PNG, set the layer's Image Mode to **3D Sliced**,
   and set Number of Passes for the total depth. Check Preview before burning.

See the [LightBurn 3D Sliced guide](https://docs.lightburnsoftware.com/latest/Guides/3DSlicedImage/).

## How it works

Each triangle is projected for the chosen view and rasterized into a height
buffer that keeps the highest surface at every pixel. Heights of the visible
surface are scaled to the gray range, and the PNG is encoded directly
(grayscale, 8 or 16 bit, with a pHYs size chunk).

## Develop

No build step. Serve the folder with any static server, for example
`python3 -m http.server`, and open it. Run the tests with `node test/test.js`.

Inspired by Arjan van de Ven's STL2PNG. This is an independent implementation.

## License

MIT
