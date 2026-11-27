"""Convert a Gaia CSV or CSV.GZ to a spatially chunked buffer for the viewer."""

import argparse
import csv
import gzip
import heapq
import math
import random
import struct
from pathlib import Path
from tempfile import NamedTemporaryFile


BUNDLED_CATALOG = Path("sample_without_parallax_error.csv.gz")
# The stream starts with the catalog header and preview, then repeats chunk header and vertices.
MAGIC = b"GAI2"
HEADER = struct.Struct("<4s6I4xd")
CHUNK_HEADER = struct.Struct("<II4d")
POSITION = struct.Struct("<3f")
PHOTOMETRY = struct.Struct("<f")
VERTEX = struct.Struct("<4f")
BYTES_PER_STAR = VERTEX.size + 4  # RGB and one padding byte
MAX_CHUNK_SIZE = 16_384
HAS_PHOTOMETRY = 1
IS_BUNDLED = 2
# Keep the photometry scale and color ramp in sync with the viewer's legacy catalog path.
ORBIT_REFERENCE_MAGNITUDE = 18
COLOR_STOPS = (
    (-0.2, (181, 205, 255)),
    (0.8, (255, 248, 240)),
    (3.6, (255, 167, 126)),
)


def linear_byte(srgb):
    linear = srgb / 12.92 if srgb <= 0.04045 else ((srgb + 0.055) / 1.055) ** 2.4
    return round(linear * 255)


GRAY = bytes(linear_byte(channel / 255) for channel in (154, 163, 178)) + b"\0"


def galactic_position(longitude, latitude, parallax):
    """Return heliocentric Galactic X, Y, Z in parsecs."""
    if not all(map(math.isfinite, (longitude, latitude, parallax))):
        raise ValueError("coordinates must be finite")
    if not 0 <= longitude <= 360 or not -90 <= latitude <= 90 or parallax <= 0:
        raise ValueError("coordinates or parallax outside their valid range")

    longitude = math.radians(longitude)
    latitude = math.radians(latitude)
    distance = 1000 / parallax
    in_plane = distance * math.cos(latitude)
    return (
        in_plane * math.cos(longitude),
        in_plane * math.sin(longitude),
        distance * math.sin(latitude),
    )


def read_photometry(row, column, offset=0):
    if column is not None:
        try:
            value = float(row[column]) + offset
            if math.isfinite(value):
                return PHOTOMETRY.unpack(PHOTOMETRY.pack(value))[0]
        except (IndexError, ValueError, OverflowError):
            pass
    return None


def star_color(bp_rp):
    if bp_rp is None:
        return GRAY
    start, end = COLOR_STOPS[:2] if bp_rp < COLOR_STOPS[1][0] else COLOR_STOPS[1:]
    fraction = min(1, max(0, (bp_rp - start[0]) / (end[0] - start[0])))
    return bytes(
        linear_byte((low + (high - low) * fraction) / 255)
        for low, high in zip(start[1], end[1])
    ) + b"\0"


def axis_ranges(stars):
    return [(min(star[axis] for star in stars), max(star[axis] for star in stars))
            for axis in range(3)]


def bounding_sphere(stars, ranges):
    cx, cy, cz = center = tuple((low + high) / 2 for low, high in ranges)
    radius = math.sqrt(max((star[0] - cx) ** 2 + (star[1] - cy) ** 2 + (star[2] - cz) ** 2
                           for star in stars))
    return (*center, radius)


def partition(stars, ranges):
    if len(stars) <= MAX_CHUNK_SIZE:
        yield stars, bounding_sphere(stars, ranges)
        return

    axis = max(range(3), key=lambda i: ranges[i][1] - ranges[i][0])
    stars.sort(key=lambda star: star[axis])
    middle = len(stars) // 2
    for half in (stars[:middle], stars[middle:]):
        yield from partition(half, axis_ranges(half))


def preview_sample(stars, rng):
    preview_count = (len(stars) + 49) // 50
    # Reserve room for bright sources in both views and sample the rest within each chunk.
    bright_count = preview_count // 4
    photometric = [i for i, star in enumerate(stars) if star[3] >= 0]
    bright = dict.fromkeys(heapq.nlargest(bright_count, photometric, key=lambda i: stars[i][3]))
    bright.update(dict.fromkeys(heapq.nlargest(bright_count, photometric, key=lambda i: stars[i][5])))
    remaining = [i for i in range(len(stars)) if i not in bright]
    selected = rng.sample(remaining, preview_count - len(bright))
    return [stars[i] for i in (*bright, *selected)]


def write_vertices(destination, stars):
    positions_and_flux = bytearray(len(stars) * VERTEX.size)
    colors = bytearray(len(stars) * 4)
    for i, (x, y, z, flux, color, _) in enumerate(stars):
        VERTEX.pack_into(positions_and_flux, i * VERTEX.size, x, y, z, flux)
        colors[i * 4:(i + 1) * 4] = color
    destination.write(positions_and_flux)
    destination.write(colors)


def prepare_catalog(source, output):
    open_catalog = gzip.open if source.suffix.lower() == ".gz" else open
    stars = []
    skipped = 0
    flags = IS_BUNDLED if source.resolve() == BUNDLED_CATALOG.resolve() else 0

    with open_catalog(source, "rt", encoding="utf-8-sig", newline="") as catalog:
        reader = csv.reader(catalog)
        fields = next(reader, [])
        required = ("l", "b", "parallax")
        if not all(field in fields for field in required):
            raise ValueError("the catalog must contain l, b, and parallax columns")

        longitude, latitude, parallax = (fields.index(field) for field in required)
        color_index = fields.index("bp_rp") if "bp_rp" in fields else None
        g_magnitude = fields.index("phot_g_mean_mag") if "phot_g_mean_mag" in fields else None
        for row in reader:
            try:
                parallax_mas = float(row[parallax])
                position = galactic_position(
                    float(row[longitude]), float(row[latitude]), parallax_mas
                )
                if not all(map(math.isfinite, position)):
                    raise ValueError("position exceeds numeric range")
                x, y, z = POSITION.unpack(POSITION.pack(*position))
            except (IndexError, ValueError, OverflowError):
                skipped += 1
                continue

            distance_modulus = 10 - 5 * math.log10(parallax_mas)
            magnitude = read_photometry(row, g_magnitude, -distance_modulus)
            flux = -1
            apparent_rank = -math.inf
            if magnitude is not None:
                flags |= HAS_PHOTOMETRY
                clamped_magnitude = min(80, max(-40, magnitude))
                flux = 10 ** (0.4 * (ORBIT_REFERENCE_MAGNITUDE - clamped_magnitude))
                apparent_rank = -(magnitude + distance_modulus)
            stars.append((x, y, z, flux, star_color(read_photometry(row, color_index)), apparent_rank))

    plotted = len(stars)
    if plotted == 0:
        raise ValueError("the catalog has no plottable positions")

    ranges = axis_ranges(stars)
    cx, cy, cz, radius = bounding_sphere(stars, ranges)
    extent = max(1, math.hypot(cx, cy, cz) + radius)
    preview = []
    chunks = []
    rng = random.Random(0)
    for chunk, bounds in partition(stars, ranges):
        chunks.append((chunk, bounds))
        preview.extend(preview_sample(chunk, rng))
    del stars

    size = HEADER.size + CHUNK_HEADER.size * len(chunks) + BYTES_PER_STAR * (plotted + len(preview))
    temporary_path = None
    try:
        with NamedTemporaryFile(dir=output.parent, prefix=".stars-", suffix=".tmp",
                                delete=False) as destination:
            temporary_path = Path(destination.name)
            destination.write(HEADER.pack(MAGIC, plotted, skipped, len(chunks), len(preview),
                                          flags, size, extent))
            write_vertices(destination, preview)
            for chunk, bounds in chunks:
                destination.write(CHUNK_HEADER.pack(len(chunk), 0, *bounds))
                write_vertices(destination, chunk)
        temporary_path.replace(output)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    return plotted, skipped


def is_current_bundled_catalog(source, output):
    if not output.is_file():
        return False
    info = output.stat()
    if info.st_mtime_ns < max(source.stat().st_mtime_ns, Path(__file__).stat().st_mtime_ns):
        return False
    with output.open("rb") as catalog:
        header = catalog.read(HEADER.size)
    if len(header) != HEADER.size:
        return False
    magic, _, _, _, _, flags, size, _ = HEADER.unpack(header)
    return magic == MAGIC and bool(flags & IS_BUNDLED) and size == info.st_size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, default=BUNDLED_CATALOG)
    parser.add_argument("output", nargs="?", type=Path, default=Path("stars.bin"))
    parser.add_argument("--if-stale", action="store_true", help="reuse the bundled build if current")
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error("input and output must be different files")

    try:
        if (args.if_stale and args.input.resolve() == BUNDLED_CATALOG.resolve()
                and is_current_bundled_catalog(args.input, args.output)):
            print(f"Using up-to-date {args.output}.")
            return
        plotted, skipped = prepare_catalog(args.input, args.output)
    except (OSError, EOFError, OverflowError, ValueError, struct.error, csv.Error) as error:
        parser.exit(1, f"{error}\n")
    print(f"Wrote {plotted:,} positions to {args.output} ({skipped:,} skipped).")


if __name__ == "__main__":
    main()
