#!/usr/bin/env python3
"""Pack low-elevation Madrigal HDF5 into browser-oriented float16 arrays."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import h5py
import numpy as np

from jcoord_numpy import ecef_to_enu_basis, geodetic2ecef

STATION_LAT = 42.61950
STATION_LON = -71.49173
STATION_ALT_KM = 0.146


def geodetic_to_local(lat, lon, alt):
    """Project geodetic arrays into the viewer's east/up/south frame."""
    target_ecef = geodetic2ecef(lat, lon, np.asarray(alt) * 1e3)
    station_ecef = geodetic2ecef(
        STATION_LAT,
        STATION_LON,
        STATION_ALT_KM * 1e3,
    ).reshape((3,) + (1,) * (target_ecef.ndim - 1))
    enu = np.einsum(
        "ij,j...->i...",
        ecef_to_enu_basis(STATION_LAT, STATION_LON),
        target_ecef - station_ecef,
        optimize=True,
    ) / 1e3
    return enu[0], enu[2], -enu[1]


def finite_percentiles(values, low=2.0, high=98.0):
    finite = values[np.isfinite(values)]
    return [float(np.percentile(finite, low)), float(np.percentile(finite, high))]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(args.input_dir.glob("mlh*k.*.hdf5"))
    if not files:
        raise SystemExit("No MISA HDF5 files found")

    records = []
    day_segments = []
    record_start = 0
    range_axis = None
    for path in files:
        with h5py.File(path, "r") as h5:
            layout = h5["Data/Array Layout"]
            one = layout["1D Parameters"]
            two = layout["2D Parameters"]
            timestamps = layout["timestamps"][:].astype(np.uint32)
            if range_axis is None:
                range_axis = layout["range"][:]
            elif not np.allclose(range_axis, layout["range"][:], equal_nan=True):
                raise RuntimeError(f"Range grid differs in {path.name}")

            ti = np.asarray(two["ti"][:])
            electron_density = np.asarray(two["ne"][:])
            te = ti * np.asarray(two["tr"][:])
            east, up, south = geodetic_to_local(
                np.asarray(two["gdlat"][:]),
                np.asarray(two["glon"][:]),
                np.asarray(two["gdalt"][:]),
            )
            block = {
                "timestamps": timestamps,
                "azimuth": one["az1"][:],
                "elevation": one["el1"][:],
                "cycle": one["cycn"][:].astype(np.uint16),
                "x": east.T,
                "y": up.T,
                "z": south.T,
                "logNe": np.log10(
                    electron_density,
                    where=electron_density > 0,
                    out=np.full_like(electron_density, np.nan),
                ).T,
                "ti": ti.T,
                "te": te.T,
                "vi": two["vo"][:].T,
            }
            records.append(block)
            count = len(timestamps)
            day_segments.append({
                "label": path.name[3:9],
                "source": path.name,
                "recordStart": record_start,
                "recordCount": count,
                "startUnix": int(timestamps[0]),
                "endUnix": int(timestamps[-1]),
            })
            record_start += count

    combined = {}
    for key in records[0]:
        combined[key] = np.concatenate([block[key] for block in records], axis=0)

    record_count = len(combined["timestamps"])
    range_count = len(range_axis)
    dense_point_count = combined["x"].size
    if dense_point_count != record_count * range_count:
        raise RuntimeError("Unexpected packed point count")

    position_mask = (
        np.isfinite(combined["x"])
        & np.isfinite(combined["y"])
        & np.isfinite(combined["z"])
    )
    point_record_index = np.repeat(np.arange(record_count, dtype=np.uint16), range_count)[position_mask.ravel()]
    point_arrays = {
        key: combined[key].ravel()[position_mask.ravel()]
        for key in ("x", "y", "z", "logNe", "ti", "te", "vi")
    }
    point_count = int(position_mask.sum())

    parameter_ranges = {
        "logNe": finite_percentiles(combined["logNe"]),
        "ti": finite_percentiles(combined["ti"]),
        "te": finite_percentiles(combined["te"]),
    }
    vi_limit = max(abs(v) for v in finite_percentiles(combined["vi"], 1.0, 99.0))
    parameter_ranges["vi"] = [-vi_limit, vi_limit]

    arrays = {}
    offset = 0
    binary_path = args.output_dir / "misa-wiper-f16.bin"
    with binary_path.open("wb") as stream:
        def write_array(name, values, dtype, type_name):
            nonlocal offset
            data = np.asarray(values, dtype=dtype).ravel(order="C")
            raw = data.tobytes(order="C")
            stream.write(raw)
            arrays[name] = {"offset": offset, "count": int(data.size), "type": type_name}
            offset += len(raw)

        write_array("timestamps", combined["timestamps"], "<u4", "u32")
        write_array("azimuth", combined["azimuth"], "<f2", "f16")
        write_array("elevation", combined["elevation"], "<f2", "f16")
        write_array("cycle", combined["cycle"], "<u2", "u16")
        write_array("pointRecordIndex", point_record_index, "<u2", "u16")
        for key in ("x", "y", "z", "logNe", "ti", "te", "vi"):
            write_array(key, point_arrays[key], "<f2", "f16")

    manifest = {
        "schema": "misa.wiper.float16.v1",
        "description": "MISA uncoded 2 ms long-pulse scans below 10 degrees elevation",
        "station": {"name": "Millstone Hill", "lat": STATION_LAT, "lon": STATION_LON, "altKm": STATION_ALT_KM},
        "kindat": 3430,
        "modeType": 115,
        "pulseLengthSeconds": 0.002,
        "scanDurationSeconds": 700,
        "recordCount": record_count,
        "rangeCount": range_count,
        "pointCount": point_count,
        "startUnix": int(combined["timestamps"][0]),
        "endUnix": int(combined["timestamps"][-1]),
        "days": day_segments,
        "parameterRanges": parameter_ranges,
        "arrays": arrays,
        "binary": binary_path.name,
        "binaryBytes": offset,
        "storage": "IEEE 754 binary16 for geometry and plasma parameters; integer timestamps and indices",
        "coordinateTransform": {
            "model": "WGS-84 geodetic to ECEF, then ECEF to Millstone east/up/south",
            "implementation": "NumPy-vectorized jcoord equations",
            "source": "https://github.com/jvierine/jcoord/blob/main/src/jcoord/jcoord.py",
        },
    }
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"binaryBytes": offset, "recordCount": record_count, "pointCount": point_count, "ranges": parameter_ranges}, indent=2))


if __name__ == "__main__":
    main()
