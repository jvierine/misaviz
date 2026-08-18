"""Check the antenna boresight convention against the packed ray geometry."""

import json
from pathlib import Path

import numpy as np


def packed_array(manifest, binary, name):
    spec = manifest["arrays"][name]
    dtype = {"u16": "<u2", "u32": "<u4", "f16": "<f2"}[spec["type"]]
    return np.frombuffer(
        binary,
        dtype=dtype,
        count=spec["count"],
        offset=spec["offset"],
    )


def main():
    data_dir = Path(__file__).parents[1] / "public" / "data"
    manifest = json.loads((data_dir / "manifest.json").read_text())
    binary = (data_dir / manifest["binary"]).read_bytes()
    record_index = packed_array(manifest, binary, "pointRecordIndex").astype(np.int64)
    positions = np.column_stack(
        [
            packed_array(manifest, binary, axis).astype(np.float64)
            for axis in ("x", "y", "z")
        ]
    )

    starts = np.flatnonzero(np.r_[True, np.diff(record_index) != 0])
    measured = positions[starts]
    measured /= np.linalg.norm(measured, axis=1, keepdims=True)
    azimuth = np.arctan2(measured[:, 0], -measured[:, 2])
    elevation = np.arctan2(
        measured[:, 1],
        np.hypot(measured[:, 0], measured[:, 2]),
    )
    expected = np.column_stack(
        [
            np.cos(elevation) * np.sin(azimuth),
            np.sin(elevation),
            -np.cos(elevation) * np.cos(azimuth),
        ]
    )
    angular_error = np.rad2deg(
        np.arccos(np.clip(np.einsum("ij,ij->i", measured, expected), -1.0, 1.0))
    )
    print(f"Median boresight error: {np.median(angular_error):.4f} deg")
    print(f"Maximum boresight error: {np.max(angular_error):.4f} deg")
    if np.max(angular_error) >= 1e-5:
        raise SystemExit("Antenna boresight does not match packed radar rays")


if __name__ == "__main__":
    main()
