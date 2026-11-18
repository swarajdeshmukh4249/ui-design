/* =========================================================
   Data sources — sensor communication only.
   ---------------------------------------------------------
   Every source exposes the same small interface so the page
   never needs to know HOW readings arrive:

     const src = new SomeSource(handlers, options);
     await src.start();   // resolves true when running, false otherwise
     await src.stop(msg); // releases all resources

   handlers = {
     onReading(reading)          // { t, v, i, p, flags[] }
     onStatus(conn, message, level)
                                 // conn: 'connecting' | 'connected' | 'disconnected'
                                 // level: 'info' | 'error'
     onRejected(line, reason)    // a line that was not a valid reading
   }

   To add a Wi-Fi source later (e.g. WebSocket or HTTP polling
   to an ESP8266/ESP32), write a class with the same interface,
   feed each received text line to parseLine(), and register it
   in app.js. Nothing else in the page needs to change.
   ========================================================= */
(function (global) {
  'use strict';

  /** Accept finite numbers (or numeric strings). Anything else is NOT a reading. */
  function toFiniteNumber(x) {
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    if (typeof x === 'string' && x.trim() !== '') {
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * Build a reading. Power is ALWAYS calculated from voltage (V) and
   * current (mA): P[W] = V × I[mA] / 1000. Negative values are kept and
   * flagged, never clamped.
   */
  function makeReading(v, iMa, t, reportedPower) {
    const p = (v * iMa) / 1000;
    const flags = [];
    if (v < 0) flags.push('negative-voltage');
    if (iMa < 0) flags.push('negative-current');
    const rp = toFiniteNumber(reportedPower);
    if (rp !== null && Math.abs(rp - p) > Math.max(0.01, Math.abs(p) * 0.05)) {
      flags.push('power-mismatch');
    }
    return { t, v, i: iMa, p, flags };
  }

  /**
   * Parse one text line such as {"voltage_V":5.2,"current_mA":180.0}.
   * Returns { ok:true, reading } or { ok:false, reason }. Never throws.
   */
  function parseLine(line, now) {
    const text = String(line).trim();
    if (!text) return { ok: false, reason: 'empty' };
    if (text[0] !== '{') return { ok: false, reason: 'not JSON' };
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, reason: 'malformed JSON' }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not an object' };
    const v = toFiniteNumber(obj.voltage_V);
    const i = toFiniteNumber(obj.current_mA);
    if (v === null || i === null) return { ok: false, reason: 'missing or invalid voltage_V / current_mA' };
    return { ok: true, reading: makeReading(v, i, typeof now === 'number' ? now : Date.now(), obj.power_W) };
  }

  /**
   * Buffers text chunks and emits complete lines. Handles data split across
   * chunks, several lines per chunk, and both LF and CRLF endings.
   */
  function createLineSplitter(onLine, onOverflow, maxLen) {
    const limit = maxLen || 4096;
    let buf = '';
    return {
      push(chunk) {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          let line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          onLine(line);
        }
        if (buf.length > limit) {           // no newline for a long time: garbage / wrong baud
          const dropped = buf;
          buf = '';
          if (onOverflow) onOverflow(dropped);
        }
      },
      reset() { buf = ''; }
    };
  }

  /* ---------------------------------------------------------
     DEMO SOURCE — clearly simulated, smoothly varying values.
     Model: panel current depends on simulated sunlight; voltage
     follows a ~30.5 Ω resistive load, so V, I and P stay consistent.
     --------------------------------------------------------- */
  class DemoSource {
    constructor(handlers) {
      this.h = handlers;
      this.kind = 'demo';
      this.timer = null;
      this.shading = false;
      this.phase = Math.random() * 600;
      this.shade = 1;
      this.i = 175;
      this.noise = 0;
    }

    static get supported() { return true; }

    async start() {
      this._clear();
      this.h.onStatus('connected', 'Demo generator running. All values are simulated.', 'info');
      this.timer = setInterval(() => this._tick(), 1000);
      this._tick();
      return true;
    }

    async stop(message) {
      this._clear();
      this.h.onStatus('disconnected', message || 'Demo generator stopped.', 'info');
    }

    setShading(on) { this.shading = !!on; }

    _clear() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

    _tick() {
      this.phase += 1;
      // Slow drift of "sunlight" plus a gentler, faster ripple (thin cloud)
      const sun = 0.86 + 0.09 * Math.sin(this.phase / 95) + 0.04 * Math.sin(this.phase / 13);
      const shadeTarget = this.shading ? 0.34 : 1;
      this.shade += (shadeTarget - this.shade) * 0.35;
      // Low-pass filtered noise so values move smoothly
      this.noise = this.noise * 0.7 + (Math.random() - 0.5) * 2.4;
      const targetI = 212 * sun * this.shade + this.noise;
      this.i += (targetI - this.i) * 0.55;
      const loadOhms = 30.5;
      const v = (this.i / 1000) * loadOhms + (Math.random() - 0.5) * 0.02;
      const iMa = this.i;
      this.h.onReading(makeReading(round(v, 3), round(iMa, 1), Date.now()));
    }
  }

  function round(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }

  /* ---------------------------------------------------------
     USB SERIAL SOURCE — Web Serial API (Chrome / Edge desktop).
     --------------------------------------------------------- */
  class SerialSource {
    constructor(handlers, options) {
      this.h = handlers;
      this.kind = 'hardware';
      this.baudRate = (options && options.baudRate) || 115200;
      this.port = null;
      this.reader = null;
      this.keepReading = false;
      this.readLoopPromise = null;
      this.stopping = false;
      this._onUsbDisconnect = this._onUsbDisconnect.bind(this);
    }

    static get secureContext() { return !!global.isSecureContext; }
    static get supported() { return !!(global.navigator && 'serial' in global.navigator); }

    async start() {
      if (!SerialSource.secureContext) {
        this.h.onStatus('disconnected', 'USB Serial needs a secure page. Open this site via http://localhost or HTTPS (see README).', 'error');
        return false;
      }
      if (!SerialSource.supported) {
        this.h.onStatus('disconnected', 'This browser does not support Web Serial. Use desktop Chrome or Edge, or switch to Demo.', 'error');
        return false;
      }

      this.h.onStatus('connecting', 'Choose the Arduino port in the browser dialog.', 'info');
      let port;
      try {
        port = await navigator.serial.requestPort();
      } catch (e) {
        const msg = e && e.name === 'NotFoundError'
          ? 'No port selected. Connection cancelled.'
          : e && e.name === 'SecurityError'
            ? 'Permission to use serial ports was denied by the browser.'
            : 'Could not request a serial port: ' + (e && e.message ? e.message : e);
        this.h.onStatus('disconnected', msg, e && e.name === 'NotFoundError' ? 'info' : 'error');
        return false;
      }

      try {
        await port.open({ baudRate: this.baudRate });
      } catch (e) {
        this.h.onStatus('disconnected',
          'Could not open the port. Close the Arduino Serial Monitor / Plotter or any other program using it, then try again. (' + (e && e.message ? e.message : e) + ')',
          'error');
        return false;
      }

      this.port = port;
      this.keepReading = true;
      navigator.serial.addEventListener('disconnect', this._onUsbDisconnect);
      this.h.onStatus('connected', 'Connected at ' + this.baudRate + ' baud. Waiting for data.', 'info');
      this.readLoopPromise = this._readLoop();
      return true;
    }

    async stop(message, level) {
      if (this.stopping) return;
      this.stopping = true;
      this.keepReading = false;
      try { navigator.serial && navigator.serial.removeEventListener('disconnect', this._onUsbDisconnect); } catch (e) { /* ignore */ }
      if (this.reader) { try { await this.reader.cancel(); } catch (e) { /* already closed */ } }
      if (this.readLoopPromise) { try { await this.readLoopPromise; } catch (e) { /* ignore */ } }
      this.readLoopPromise = null;
      if (this.port) { try { await this.port.close(); } catch (e) { /* port may already be gone */ } }
      this.port = null;
      this.h.onStatus('disconnected', message || 'Disconnected.', level || 'info');
    }

    _onUsbDisconnect(ev) {
      if (ev && ev.target === this.port) this._lost('USB device was unplugged.');
    }

    _lost(message) {
      if (this.stopping) return;
      // Called from inside the read loop or the disconnect event: do not await the loop itself.
      this.keepReading = false;
      this.readLoopPromise = null;
      this.stop(message, 'error');
    }

    async _readLoop() {
      const decoder = new TextDecoder();
      const splitter = createLineSplitter(
        (line) => this._handleLine(line),
        (dropped) => this.h.onRejected(dropped.slice(0, 80), 'no line ending (check baud rate)')
      );
      while (this.keepReading && this.port && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) splitter.push(decoder.decode(value, { stream: true }));
          }
        } catch (e) {
          // Non-fatal errors (framing, buffer overrun) leave port.readable available
          // and the loop continues. Fatal errors (unplug) make it null.
          if (this.keepReading) this.h.onRejected('', 'read error: ' + (e && e.message ? e.message : e));
        } finally {
          try { this.reader.releaseLock(); } catch (e) { /* ignore */ }
          this.reader = null;
        }
      }
      if (this.keepReading) this._lost('Serial connection lost.');
    }

    _handleLine(line) {
      const res = parseLine(line);
      if (res.ok) this.h.onReading(res.reading);
      else if (res.reason !== 'empty') this.h.onRejected(line, res.reason);
    }
  }

  global.SolarSources = { DemoSource, SerialSource, parseLine, makeReading, createLineSplitter };
})(typeof window !== 'undefined' ? window : globalThis);
