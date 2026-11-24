# visualising-gaia

Explore the local Galactic disk in Three.js. The bundled Gaia sample contains 765,166 sources.

## Run locally

Install Python 3 and Node.js with npm, then run these commands from the repository root.

```sh
npm ci
npm start
```

Open [the star map](http://127.0.0.1:8000) in a WebGL 2 browser. In PowerShell, use `npm.cmd` if script execution is disabled.

- Left-drag to pan and right-drag to orbit.
- Scroll to zoom toward the pointer, or use the **+** and **−** buttons to zoom around the center.
- On touchscreens, drag to pan and pinch to zoom.
- Focus the map and use the arrow keys to pan. Select **Reset view** to return to the full catalog.

## Coordinates

The viewer uses heliocentric Galactic coordinates. X points toward Galactic longitude 0°, Y toward longitude 90°, and Z toward the north Galactic pole. Each row with valid coordinates becomes one Three.js point.

The converter reads Galactic longitude `l` and latitude `b` in degrees and parallax in milliarcseconds. It converts the angles to radians and estimates distance `d` in parsecs as `1000 / parallax`. These are direct inverse-parallax estimates.

```text
X = d × cos(b) × cos(l)
Y = d × cos(b) × sin(l)
Z = d × sin(b)
```

`npm start` generates `stars.bin` from the bundled compressed catalog. To plot another CSV or gzipped CSV with the same three columns, prepare it and start the server directly.

```sh
python prepare_stars.py my_catalog.csv.gz
python -m http.server 8000 --bind 127.0.0.1
```

The converter reports skipped rows with missing or invalid coordinates or nonpositive parallax.

## Star colors

The viewer maps `bp_rp` continuously from red at 0.7 through amber at 1.3 to blue at 1.9. Values beyond the endpoints use the endpoint colors. Sources with missing or invalid BP–RP appear gray, including when a custom catalog has no `bp_rp` column.

## Star brightness

The converter uses `phot_g_mean_mag` and the same parallax distance estimate to calculate absolute G magnitude at 10 parsecs, without an extinction correction.

```text
M_G = phot_g_mean_mag − 5 × log10(d / 10)
```

Lower absolute magnitudes produce brighter points. Faint sources have a low brightness floor, and overlapping glows keep the strongest contribution per color channel to limit glare. The viewer uses a default brightness when G photometry is unavailable. Restart with `npm start` to regenerate an older `stars.bin` with magnitude data.
