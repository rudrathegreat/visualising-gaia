"""Convert a Gaia CSV or CSV.GZ to a compact buffer for the viewer."""

import argparse
import csv
import gzip
import math
import struct
from pathlib import Path
from tempfile import NamedTemporaryFile


HEADER = struct.Struct("<II")
POSITION = struct.Struct("<fff")
PHOTOMETRY_VALUE = struct.Struct("<f")
MISSING_PHOTOMETRY = PHOTOMETRY_VALUE.pack(math.nan)


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


def pack_photometry(row, column, offset=0):
    if column is not None:
        try:
            value = float(row[column]) + offset
            if math.isfinite(value):
                return PHOTOMETRY_VALUE.pack(value)
        except (IndexError, ValueError, OverflowError):
            pass
    return MISSING_PHOTOMETRY


def prepare_catalog(source, output):
    open_catalog = gzip.open if source.suffix.lower() == ".gz" else open
    plotted = skipped = 0
    temporary_path = None

    try:
        with open_catalog(source, "rt", encoding="utf-8-sig", newline="") as catalog:
            reader = csv.reader(catalog)
            fields = next(reader, [])
            required = ("l", "b", "parallax")
            if not all(field in fields for field in required):
                raise ValueError("the catalog must contain l, b, and parallax columns")
            longitude, latitude, parallax = (fields.index(field) for field in required)
            color_index = fields.index("bp_rp") if "bp_rp" in fields else None
            g_magnitude = fields.index("phot_g_mean_mag") if "phot_g_mean_mag" in fields else None

            with NamedTemporaryFile(dir=output.parent, prefix=".stars-", suffix=".tmp",
                                    delete=False) as destination:
                temporary_path = Path(destination.name)
                destination.write(HEADER.pack(0, 0))
                for row in reader:
                    try:
                        parallax_mas = float(row[parallax])
                        position = galactic_position(
                            float(row[longitude]), float(row[latitude]), parallax_mas
                        )
                        if not all(map(math.isfinite, position)):
                            raise ValueError("position exceeds numeric range")
                        packed = POSITION.pack(*position)
                    except (IndexError, ValueError, OverflowError):
                        skipped += 1
                        continue
                    destination.write(packed)
                    destination.write(pack_photometry(row, color_index))
                    distance_modulus = 10 - 5 * math.log10(parallax_mas)
                    destination.write(pack_photometry(row, g_magnitude, -distance_modulus))
                    plotted += 1

                if plotted == 0:
                    raise ValueError("the catalog has no plottable positions")
                destination.seek(0)
                destination.write(HEADER.pack(plotted, skipped))

        temporary_path.replace(output)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    return plotted, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path,
                        default=Path("sample_without_parallax_error.csv.gz"))
    parser.add_argument("output", nargs="?", type=Path, default=Path("stars.bin"))
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error("input and output must be different files")

    try:
        plotted, skipped = prepare_catalog(args.input, args.output)
    except (OSError, EOFError, ValueError, csv.Error) as error:
        parser.exit(1, f"{error}\n")
    print(f"Wrote {plotted:,} positions to {args.output} ({skipped:,} skipped).")


if __name__ == "__main__":
    main()
