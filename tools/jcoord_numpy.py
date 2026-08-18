"""Vectorized WGS-84 transforms used by the MISA browser-data packer.

The equations and constants follow Juha Vierinen's tested ``jcoord`` module:
https://github.com/jvierine/jcoord/blob/main/src/jcoord/jcoord.py

Only NumPy is used for numerical work, and every function accepts scalars or
arbitrarily shaped arrays through NumPy broadcasting.
"""

from __future__ import annotations

import numpy as np


# World Geodetic System 1984 constants, matching jcoord.
WGS84_A_M = np.float64(6378.137e3)
WGS84_ESQ = np.float64(6.69437999014e-3)


def geodetic2ecef(lat_deg, lon_deg, altitude_m) -> np.ndarray:
    """Convert WGS-84 geodetic coordinates to an ECEF vector in metres."""
    latitude = np.deg2rad(np.asarray(lat_deg, dtype=np.float64))
    longitude = np.deg2rad(np.asarray(lon_deg, dtype=np.float64))
    altitude = np.asarray(altitude_m, dtype=np.float64)
    xi = np.sqrt(1.0 - WGS84_ESQ * np.sin(latitude) ** 2)
    radius = WGS84_A_M / xi
    x = (radius + altitude) * np.cos(latitude) * np.cos(longitude)
    y = (radius + altitude) * np.cos(latitude) * np.sin(longitude)
    z = (radius * (1.0 - WGS84_ESQ) + altitude) * np.sin(latitude)
    return np.stack(np.broadcast_arrays(x, y, z), axis=0)


def ecef_to_enu_basis(lat_deg, lon_deg) -> np.ndarray:
    """Return rows that project an ECEF displacement onto east, north, up."""
    latitude = np.deg2rad(np.asarray(lat_deg, dtype=np.float64))
    longitude = np.deg2rad(np.asarray(lon_deg, dtype=np.float64))
    sin_lat, cos_lat = np.sin(latitude), np.cos(latitude)
    sin_lon, cos_lon = np.sin(longitude), np.cos(longitude)
    return np.asarray(
        [
            [-sin_lon, cos_lon, 0.0],
            [-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat],
            [cos_lat * cos_lon, cos_lat * sin_lon, sin_lat],
        ],
        dtype=np.float64,
    )
