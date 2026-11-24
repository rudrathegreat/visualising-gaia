import argparse
import csv
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Remove parallax_error from a CSV.")
    parser.add_argument("input", nargs="?", type=Path, default=Path("sample.csv"))
    parser.add_argument(
        "output", nargs="?", type=Path, default=Path("sample_without_parallax_error.csv")
    )
    args = parser.parse_args()

    try:
        with args.input.open(encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source)
            header = next(reader, [])
            if "parallax_error" not in header:
                parser.exit(1, f"{args.input}: missing parallax_error column\n")

            column = header.index("parallax_error")
            with args.output.open("x", encoding="utf-8", newline="") as destination:
                writer = csv.writer(destination)
                writer.writerow(header[:column] + header[column + 1 :])
                for row in reader:
                    writer.writerow(row[:column] + row[column + 1 :])
    except (OSError, csv.Error) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
