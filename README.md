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
- Select **View from Sun** to look out from the heliocentric origin. Drag to look around, use Ctrl+arrow keys when the map is focused, or zoom to change the field of view. Select **View from Sun** again to resume the previous orbit view. **Reset view** in this mode looks toward Galactic longitude and latitude 0°.
- Select **Fly through** to travel from the Sun through the 3D star field. Drag to look around, hold **WASD** to move and **Q/E** to descend or climb. Hold **Shift** to move faster, or use the scroll wheel or **+** and **−** to step forward and backward. **Reset view** returns to the Sun. Select **Fly through** again to return to the previous view.
- Adjust **Exposure** in any view. Higher values lift faint stars more strongly and flatten the brightness falloff with magnitude.

## Coordinates

The viewer uses heliocentric Galactic coordinates. X points toward Galactic longitude 0°, Y toward longitude 90°, and Z toward the north Galactic pole. Each row with valid coordinates becomes one Three.js point.

The converter reads Galactic longitude `l` and latitude `b` in degrees and parallax in milliarcseconds. It converts the angles to radians and estimates distance `d` in parsecs as `1000 / parallax`. These are direct inverse-parallax estimates.

```text
X = d × cos(b) × cos(l)
Y = d × cos(b) × sin(l)
Z = d × sin(b)
```

`npm start` generates `stars.bin` from the bundled compressed catalog and reuses it until the source or converter changes. The generated file stores spatial chunks with precomputed colors, fluxes, and bounds. The viewer displays a preview while the full catalog downloads. It skips chunks outside the camera's view and uses smaller glows for faint stars at any speed.

To plot another CSV or gzipped CSV with the same three columns, prepare it and start the server directly.

```sh
python prepare_stars.py my_catalog.csv.gz
python -m http.server 8000 --bind 127.0.0.1
```

The converter reports skipped rows with missing or invalid coordinates or nonpositive parallax.

Older `stars.bin` files still load. Regenerate them with the current converter to enable the streamed preview and spatial chunking.

## Star colors

The viewer maps `bp_rp` continuously from pale blue at −0.2 through warm white at 0.8 to soft orange at 3.6. Values beyond the endpoints use the endpoint colors. Sources with missing or invalid BP–RP appear gray, including when a custom catalog has no `bp_rp` column.

## Star brightness

The converter uses `phot_g_mean_mag` and the same parallax distance estimate to calculate absolute G magnitude at 10 parsecs, without an extinction correction.

```text
M_G = phot_g_mean_mag − 5 × log10(d / 10)
```

The generated catalog stores relative flux at 10 parsecs. The viewer scales that flux by the inverse square of the distance to the camera. From the Sun this recovers the catalog's observed G magnitude, within the precision of the stored values. Both views compress bright flux for display and use different default exposures to suit their viewing distances. Sources without G photometry use a fixed fallback flux before exposure.
