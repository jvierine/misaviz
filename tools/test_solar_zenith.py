"""Validate the browser solar ephemeris against Astropy at Millstone Hill."""

from datetime import datetime, timezone

import astropy.units as u
import numpy as np
from astropy.coordinates import AltAz, EarthLocation, get_sun
from astropy.time import Time


def browser_solar_altitude(unix_seconds: float, latitude_deg: float, longitude_deg: float) -> float:
    julian_date = unix_seconds / 86_400.0 + 2_440_587.5
    days = julian_date - 2_451_545.0
    mean_longitude = np.deg2rad(np.mod(280.460 + 0.9856474 * days, 360.0))
    anomaly = np.deg2rad(np.mod(357.528 + 0.9856003 * days, 360.0))
    ecliptic_longitude = (
        mean_longitude
        + np.deg2rad(1.915) * np.sin(anomaly)
        + np.deg2rad(0.020) * np.sin(2.0 * anomaly)
    )
    obliquity = np.deg2rad(23.439 - 0.0000004 * days)
    eci = np.array(
        [
            np.cos(ecliptic_longitude),
            np.cos(obliquity) * np.sin(ecliptic_longitude),
            np.sin(obliquity) * np.sin(ecliptic_longitude),
        ]
    )
    centuries = (julian_date - 2_451_545.0) / 36_525.0
    sidereal_degrees = np.mod(
        280.46061837
        + 360.98564736629 * (julian_date - 2_451_545.0)
        + 0.000387933 * centuries**2
        - centuries**3 / 38_710_000.0,
        360.0,
    )
    sidereal = np.deg2rad(sidereal_degrees)
    cosine, sine = np.cos(sidereal), np.sin(sidereal)
    ecef = np.array(
        [
            cosine * eci[0] + sine * eci[1],
            -sine * eci[0] + cosine * eci[1],
            eci[2],
        ]
    )
    latitude, longitude = np.deg2rad([latitude_deg, longitude_deg])
    station_up = np.array(
        [
            np.cos(latitude) * np.cos(longitude),
            np.cos(latitude) * np.sin(longitude),
            np.sin(latitude),
        ]
    )
    return float(np.rad2deg(np.arcsin(np.dot(station_up, ecef))))


def main() -> None:
    latitude, longitude, height_m = 42.61950, -71.49173, 146.0
    instant = datetime(2024, 4, 8, 19, 29, tzinfo=timezone.utc)
    unix_seconds = instant.timestamp()
    time = Time(instant)
    site = EarthLocation.from_geodetic(
        lon=longitude * u.deg,
        lat=latitude * u.deg,
        height=height_m * u.m,
    )
    astropy_altaz = get_sun(time).transform_to(AltAz(obstime=time, location=site))
    astropy_altitude = float(astropy_altaz.alt.deg)
    browser_altitude = browser_solar_altitude(unix_seconds, latitude, longitude)
    error = abs(browser_altitude - astropy_altitude)
    print(f"Astropy solar altitude: {astropy_altitude:.6f} deg")
    print(f"Browser solar altitude: {browser_altitude:.6f} deg")
    print(f"Absolute error: {error:.6f} deg")
    if error >= 0.02:
        raise SystemExit("Solar altitude error exceeds 0.02 degrees")
    if astropy_altitude <= 0.0:
        raise SystemExit("The observation should be in daylight")


if __name__ == "__main__":
    main()
