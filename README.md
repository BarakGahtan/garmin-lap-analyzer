# Garmin Lap Analyzer

A Chrome extension that computes **per-lap heart rate stats from raw per-second data** on Garmin Connect activity pages. Garmin shows you max and average HR per lap, but never the minimum. This extension fills that gap.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow)

## What it does

When viewing any activity on [Garmin Connect](https://connect.garmin.com), a **Lap Stats** button appears. Click it to:

- Select which laps to analyze
- See **min HR, max HR, avg HR** computed from raw per-second measurements
- See **avg pace** and **distance** per lap
- Copy the results as a clean, plain-text table

### Example output

```
Lap  | Distance  | Avg Pace  | Min HR | Max HR | Avg HR
-----|-----------|-----------|--------|--------|-------
   1 |  1.00 km |  5:15/km |    120 |    162 |    145
   2 |  1.00 km |  5:08/km |    130 |    168 |    152
   3 |  1.00 km |  5:02/km |    128 |    175 |    155
   4 |  0.40 km |  3:22/km |    135 |    164 |    143
```

## Why

Garmin Connect shows max HR and average HR per lap, but **not minimum HR**. If you're doing interval training and want to see how far your heart rate drops during recovery laps, or want a quick copyable summary of your workout, there's no built-in way to get that.

This extension reads the raw per-second heart rate measurements from Garmin's API and computes all three stats (min, max, avg) for any combination of laps you select.

## Installation

1. **Clone** this repo:
   ```bash
   git clone https://github.com/BarakGahtan/garmin-lap-analyzer.git
   ```

2. Open **chrome://extensions/** in Chrome

3. Enable **Developer mode** (top-right toggle)

4. Click **Load unpacked** and select the cloned `garmin-lap-analyzer` folder

5. Navigate to any activity on Garmin Connect — look for the blue **Lap Stats** button in the bottom-right corner

## How it works

```
Garmin Connect activity page
        |
        v
  page-fetch.js (MAIN world)
    - Captures CSRF token from Garmin's own XHR calls
    - Fetches activity data using Garmin's internal /gc-api/ endpoints
    - Tries FIT binary download first, falls back to JSON activity API
        |
        v
  content.js (ISOLATED world)
    - Extracts FIT from ZIP or parses JSON activity details
    - Matches per-second records to laps using cumulative distance
    - Computes min/max/avg HR from raw measurements
    - Renders lap selector UI + copyable stats table
```

### Key technical details

- **Authentication**: Captures the `Connect-Csrf-Token` header from Garmin's own page requests — no passwords or tokens stored
- **FIT parser**: Custom binary parser for the [FIT protocol](https://developer.garmin.com/fit/protocol/) (`fit-parser.js`), handling definition/data messages, compressed timestamps, and field scaling
- **ZIP extraction**: In-browser ZIP decompression using the `DecompressionStream` API (no external dependencies)
- **Record-to-lap matching**: Uses cumulative distance boundaries to correctly assign per-second measurements to laps
- **SPA support**: Monitors URL changes to handle Garmin Connect's single-page navigation

## Project structure

```
garmin-lap-analyzer/
  manifest.json     Chrome MV3 extension manifest
  page-fetch.js     MAIN world script — auth capture + API requests
  content.js        ISOLATED world — UI, data parsing, stats computation
  content.css       Styles for the floating button and modal panel
  fit-parser.js     Binary FIT protocol parser
  background.js     Service worker (minimal, for future use)
  icons/            Extension icons
```

## Privacy

- **No external servers** — all data stays in your browser
- **No stored credentials** — authentication piggybacks on your active Garmin Connect session
- **No tracking** — zero analytics, zero telemetry
- Only activates on `connect.garmin.com`

## Requirements

- Google Chrome or any Chromium-based browser (Edge, Brave, Arc, etc.)
- An active Garmin Connect account

## Contributing

Issues and pull requests are welcome. If the extension breaks after a Garmin Connect update, it's most likely a change to their API URL prefix (`/gc-api/`) or required headers — check `page-fetch.js`.

## License

[MIT](LICENSE)
