# Solar Tracker — Live Measurements & Experimental Comparison

**Project:** Automatic Single-Axis Solar Tracking System with Reflectors and Solar Power Monitoring
**Course:** Logic Design and Microprocessors · **Group:** SY-K-05

A single-page dashboard that shows live voltage, current and power from the Arduino. It plots a live trend, records labelled experiment sessions (configurations A–D), compares them, and exports the raw samples as CSV. It only monitors and records. It does not control the motor.

## Files

```
solar-tracker/
├── index.html      page structure
├── styles.css      visual design (Cuberto-style: white/black, pill buttons, big type)
├── js/sources.js   data sources: Demo generator, USB Web Serial, line parser
├── js/storage.js   IndexedDB session storage
├── js/app.js       rendering, recording, comparison, CSV export
├── js/motion.js    animation only: loader, cursor, magnetic buttons, reveals, smooth
│                   scroll, stacking cards, parallax, marquee, 2D fallback hero scene
├── js/webgl.js     WebGL (three.js): 3D hero tracker with bloom, scroll-driven particle
│                   morph (sun → tracker → waveform), shader light rays in the outro
└── README.md


## Design and animation

The layout follows cuberto.com's design language, with this project's own content:
centred hero with a large preview card that grows on scroll, a word-by-word reading
reveal, numbered stacking cards, a marquee, black "inverse" sections with staggered
A–D configuration tiles, an FAQ accordion, a pyramid-glow outro and a black footer.
Interactions: custom cursor (mouse/trackpad only), magnetic buttons, rolling button
text, headline reveals and Lenis smooth scrolling.

The hero animation is an illustration. Its sun and panel angle are not measured.
Its energy particles flow faster when the live power reading is higher, and stop
when there is no data.

WebGL layer (inspired by lusion.co and igloo.inc):
- **3D hero:** a real-time tracker with a cell-textured glossy panel, mirror reflectors, a blooming sun, floating light dust and energy particles driven by the live power reading. The camera follows the mouse and orbits as you scroll.
- **Particle morph:** about 11,000 particles (5,000 on phones) morph from the sun into the tracker, then into a power waveform as you scroll, with the step text changing alongside.
- **Outro:** animated shader light rays that drift toward the mouse.
- **Loader:** a short intro with a percentage counter. It never waits longer than about 3 seconds.

Each WebGL scene only renders while it is on screen. If WebGL is unavailable or three.js can't load, the page falls back to the 2D canvas hero and a static three-step list.

All motion is switched off when the operating system's "reduce motion" setting is on.
```

Sensor communication (`sources.js`) is kept separate from the page logic (`app.js`). To add Wi-Fi later, for example an ESP8266/ESP32 WebSocket, write one class with the same `start()` / `stop()` / `onReading` interface described at the top of `sources.js`. Nothing else needs to change.

## Run it

USB Serial needs a secure context, which means `localhost` or HTTPS. Serve the folder locally:

```bash
cd solar-tracker
python3 -m http.server 8000
# then open http://localhost:8000 in Chrome or Edge
```

Demo mode also works if you open `index.html` directly. Use the local server for the classroom demo anyway.

## Connect the Arduino (USB Serial)

1. Use desktop **Chrome or Edge**. Firefox and Safari do not support Web Serial. The page tells you if your browser can't use it.
2. **Close the Arduino IDE Serial Monitor and Serial Plotter.** Only one program can open the port at a time.
3. Select **USB Serial** in the header, set the baud rate to match `Serial.begin()` (default **115200**), press **Connect**, then choose the board's port.
4. The status shows **Connected · Waiting for data**, then **Fresh** once valid lines arrive. If no valid sample arrives for 5 s, it shows **Stale**.
5. Unplugging the cable shows **Disconnected**, stops any active recording, and keeps the samples already captured.

### Expected Arduino output

One JSON object per line, about once per second:

```json
{"voltage_V":5.2,"current_mA":180.0}
```

`power_W` is optional and ignored for calculations. The dashboard always computes `power_W = voltage_V × current_mA / 1000`.

Minimal sketch shape (use your own sensor-reading code):

```cpp
void setup() { Serial.begin(115200); }

void loop() {
  float voltage_V  = readVoltage();   // your sensor code
  float current_mA = readCurrent();   // your sensor code
  Serial.print("{\"voltage_V\":");
  Serial.print(voltage_V, 3);
  Serial.print(",\"current_mA\":");
  Serial.print(current_mA, 1);
  Serial.println("}");                // println adds CRLF, which is handled
  delay(1000);
}
```

Lines that are not valid JSON, such as `Calibrating...`, are ignored without crashing and counted under the live readings. Missing or non-numeric fields are rejected; they never become zero. Negative values are kept as received and flagged.

## Recording and comparison

- Pick configuration **A–D**. This only labels the experiment; it does not move the tracker or the reflectors. Add an optional name and notes, then press **Start recording**. The configuration is locked until you press **Stop**.
- Every received sample is stored in memory while recording. The session is written to browser storage **once**, when recording stops.
- In **Compare**, tick at least two sessions **from the same source**. Demo and hardware sessions are never mixed. Demo bars are hatched and labelled *SIMULATED DATA*.
- Average power is the mean of the individual power samples, not average V × average I.
- **Mean power change** = (test − baseline) ÷ baseline × 100. It shows *N/A* when baseline power is ≤ 0.

## CSV format

```
timestamp_iso,elapsed_s,session_name,configuration,data_source,voltage_V,current_mA,power_W,notes
```

Each row is one captured sample. Fields containing commas, quotes or line breaks are escaped. Files are UTF-8 with a BOM so Excel opens them correctly. Example filename: `solar-tracker_SY-K-05_config-D_noon-run_20261117-121502_hardware.csv`.

## Data storage

Sessions are stored in **this browser on this device** using IndexedDB. They are **not** backed up to the cloud. Clearing site data, using a private window or switching computers loses them, so **export important results as CSV**. If storage is unavailable, the page says so and keeps sessions for the current visit only.

## Network dependencies and offline use

The page loads two things from the internet:

| What | From |
|---|---|
| Inter Tight font | `fonts.googleapis.com` / `fonts.gstatic.com` |
| Chart.js 4.4.1 | `cdnjs.cloudflare.com` |
| Lenis 1.1.13 (smooth scrolling) | `cdn.jsdelivr.net` |
| three.js 0.160.0 (WebGL, ES modules via import map) | `cdn.jsdelivr.net` |

Without internet, the font falls back to the system sans-serif and scrolling falls back to the browser's native smooth scroll. The charts show a "library did not load" message, while readings, recording, the session table and CSV export keep working.

**To make it fully offline before the demo:**

1. Download `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js` into `solar-tracker/vendor/`, then change the script tag in `index.html` to `vendor/chart.umd.min.js`.
2. Download `https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js` into `vendor/` and point its script tag there.
   For three.js, run `npm pack three@0.160.0` (or download the package), copy `build/three.module.js` and the `examples/jsm/` folder into `vendor/three/`, and change the two URLs in the `<script type="importmap">` in `index.html` to `vendor/three/three.module.js` and `vendor/three/jsm/`.
3. Download Inter Tight (weights 400/500/600, `.woff2`) into `solar-tracker/fonts/` and replace the Google Fonts `<link>` with `@font-face` rules in `styles.css`, for example:
   ```css
   @font-face { font-family: "Inter Tight"; src: url("fonts/InterTight-Medium.woff2") format("woff2"); font-weight: 500; font-display: swap; }
   ```

## Known limitations

- USB Serial works only in desktop Chrome or Edge, on `localhost` or HTTPS.
- Timestamps come from the computer's clock when each line arrives, not from the Arduino.
- The live chart keeps the latest 300 samples. Recordings keep every sample, but very long recordings (many hours) use more memory and storage.
- The hero animation is an illustration. The tracker angle and motor state are not received or shown.
- The 3D-like animations are canvas/CSS based and are tuned for laptops. On very old machines, turn on "reduce motion" in the OS for a static version.
- A short recording compares mean power over that interval only. It says nothing about daily energy.

## Classroom demo checklist

- [ ] Start the local server (`python3 -m http.server 8000`) and open `http://localhost:8000` in Chrome.
- [ ] Optional: confirm fonts and charts load, or use the offline copies above.
- [ ] Close the Arduino Serial Monitor and Plotter.
- [ ] Select **USB Serial**, choose **115200**, press **Connect**, pick the port. The status should show **Connected · Fresh**.
- [ ] Check the readings are plausible (V, mA, W) and the trend chart is moving.
- [ ] Record **A** for 1–2 min, then **D** for 1–2 min, under similar sunlight and the same load. Write the conditions in Notes.
- [ ] In Compare, tick both sessions and show the bar chart and the mean power change.
- [ ] Download the CSV for each session (or **Export all**) and keep it as evidence.
- [ ] Backup plan: switch to **Demo** to show how the interface works. It is clearly labelled *SIMULATED DATA*.
