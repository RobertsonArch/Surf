# Surf

Surf day-at-a-glance site for Angeles Point (Strait of Juan de Fuca) and Tofino/Ucluelet.

- `scripts/fetch.py` pulls live NOAA buoy and wind data, NOAA and DFO tide/current predictions and the Open-Meteo wind forecast into `data/`.
- `.github/workflows/update.yml` runs it every hour and commits the new data; GitHub Pages serves the site from `main`.
- Pages: `index.html`, `ap.html`, `tofino.html`, `calendar.html`, `calculator.html`.
