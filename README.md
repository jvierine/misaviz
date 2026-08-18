# MISA Eclipse Scan Viewer

Browser-only Three.js/WebGL visualization of the Millstone Hill Ionospheric
Steerable Antenna (MISA) uncoded long-pulse observations from 7–9 April 2024.
The deployed viewer is available at [juha.no/misa](https://juha.no/misa/).

## Features

- Native unsmoothed radar measurement cells with selectable plasma parameter
- Fading scan history or persistent latest-value-per-azimuth display
- Time slider and automatic windshield-wiper playback
- Turbo colormap for density and temperatures; seismic for ion velocity
- NASA Blue Marble Earth surface, solar illumination, and 2024 eclipse shadow
- Geographic 100–1000 km altitude rulers over Florida and Hearst, Ontario
- Procedural 46 m MISA mesh with measured azimuth/elevation boresight kinematics
- Mouse, touch, trackpad, and keyboard camera controls
- Static Apache deployment with no server backend

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
npm test
npm run lint
npm run build:apache
```

`build:apache` creates the ignored `apache-dist/` directory for deployment at
the `/misa/` Apache path.

## Data preparation and validation

The browser data are packed from MIT Haystack Madrigal HDF5 products by
`tools/pack_misa.py`. Numerical coordinate work is vectorized with NumPy. The
WGS-84 transform in `tools/jcoord_numpy.py` follows the tested equations in
[jcoord](https://github.com/jvierine/jcoord/tree/main/src/jcoord).

Run the scientific checks with the base Conda environment:

```bash
conda run -n base python tools/test_misa_boresight.py
conda run -n base python tools/test_solar_zenith.py
```

The solar validation compares the browser ephemeris with Astropy at Millstone
Hill. The boresight validation checks the two-axis antenna convention against
the packed radar-ray geometry.

## Sources and credits

- [MIT Haystack: Millstone Hill Geospace Facility](https://www.haystack.mit.edu/the-millstone-hill-geospace-facility/)
- [MISA reference photograph](https://commons.wikimedia.org/wiki/File:Millstone_Hill_Radar_-_Haystack_Observatory_-_DSC04019.JPG)
- [NASA/GSFC 8 April 2024 eclipse path](https://eclipse.gsfc.nasa.gov/SEhistory/SEpath/SE2024Apr08Tpath.html)
- [Bernstein/Sanya ISR visualization](https://juha.no/bernstein/interactive_sanya_isr.html)
- NASA Blue Marble Next Generation Earth imagery

The MIT Haystack name and logo remain the property of MIT Haystack Observatory.
