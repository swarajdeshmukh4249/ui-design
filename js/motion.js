/* =========================================================
   Motion layer (Cuberto-style interactions).
   Purely presentational: no data logic lives here.
   Everything is disabled for prefers-reduced-motion, and the
   custom cursor only runs on fine pointers (mouse/trackpad).
   ========================================================= */
(function () {
  'use strict';

  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const navH = () => document.getElementById('site-header').offsetHeight;

  if (!reduced) root.classList.add('motion');

  /* ---------------- Intro loader ---------------- */
  (function loader() {
    const el = document.getElementById('loader');
    if (!el || reduced) { if (el) el.remove(); return; }
    const count = document.getElementById('loader-count');
    const bar = document.getElementById('loader-bar');
    let shown = 0, target = 30, done = false;
    const t0 = performance.now();
    const finish = () => {
      if (done) return;
      done = true;
      target = 100;
    };
    window.addEventListener('webgl:done', finish, { once: true });
    window.addEventListener('load', () => { target = Math.max(target, 80); });
    setTimeout(finish, 2600);                       // never hold the page hostage
    (function tick() {
      const elapsed = performance.now() - t0;
      if (!done) target = Math.min(90, Math.max(target, 30 + elapsed / 30));
      shown += (target - shown) * 0.12;
      if (target - shown < 0.5) shown = target;
      count.textContent = Math.round(shown);
      bar.style.transform = 'scaleX(' + (shown / 100).toFixed(3) + ')';
      if (done && shown >= 100) {
        setTimeout(() => {
          el.classList.add('is-done');
          setTimeout(() => el.classList.add('is-gone'), 1200);
        }, 180);
        return;
      }
      requestAnimationFrame(tick);
    })();
  })();

  /* ---------------- Text splitting ---------------- */
  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  document.querySelectorAll('[data-split]').forEach((elm) => {
    const words = elm.textContent.trim().split(/\s+/);
    elm.innerHTML = words.map((w, i) => '<span class="split-w"><span class="split-i" style="--i:' + i + '">' + esc(w) + '</span></span>').join(' ');
  });
  const wordBlocks = Array.from(document.querySelectorAll('[data-words]')).map((elm) => {
    const words = elm.textContent.trim().split(/\s+/);
    elm.innerHTML = words.map((w) => '<span class="word">' + esc(w) + '</span>').join(' ');
    return { elm, words: Array.from(elm.querySelectorAll('.word')) };
  });

  /* ---------------- Reveal on scroll ---------------- */
  const revealTargets = document.querySelectorAll('[data-reveal], [data-split]');
  if (!reduced && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    revealTargets.forEach((t) => io.observe(t));
  } else {
    revealTargets.forEach((t) => t.classList.add('is-in'));
    wordBlocks.forEach((b) => b.words.forEach((w) => w.classList.add('on')));
  }

  /* ---------------- Smooth scroll (Lenis) ---------------- */
  let lenis = null;
  document.querySelectorAll('.table-wrap, dialog, .chart-box').forEach((n) => n.setAttribute('data-lenis-prevent', ''));
  if (!reduced && window.Lenis) {
    try {
      lenis = new window.Lenis({ lerp: 0.09, smoothWheel: true });
      const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
      lenis.on('scroll', onScroll);
      // Stop page scrolling while a modal dialog is open
      const mo = new MutationObserver(() => {
        const anyOpen = !!document.querySelector('dialog[open]');
        if (anyOpen) lenis.stop(); else lenis.start();
      });
      document.querySelectorAll('dialog').forEach((d) => mo.observe(d, { attributes: true, attributeFilter: ['open'] }));
    } catch (e) { lenis = null; }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute('href');
    const target = id === '#top' ? document.body : document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(id === '#top' ? 0 : target, { offset: -navH() - 8, duration: 1.4 });
    else window.scrollTo({ top: id === '#top' ? 0 : target.getBoundingClientRect().top + scrollY - navH() - 8, behavior: reduced ? 'auto' : 'smooth' });
    if (target.tabIndex < 0 && target !== document.body) target.setAttribute('tabindex', '-1');
    if (target !== document.body) target.focus({ preventScroll: true });
  });

  /* ---------------- Marquee that reacts to scroll speed ---------------- */
  (function marquee() {
    const track = document.querySelector('.marquee-track');
    if (!track || reduced) return;
    track.style.animation = 'none';
    let x = 0, last = performance.now(), boost = 0, lastY = window.scrollY;
    (function loop(t) {
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      const y = window.scrollY;
      const vel = lenis ? lenis.velocity : (y - lastY) / Math.max(dt, 0.001) / 60;
      lastY = y;
      boost += (Math.min(40, Math.abs(vel)) * Math.sign(vel || 1) - boost) * 0.08;
      const half = track.scrollWidth / 2;
      x -= (60 + boost * 22) * dt;
      if (x <= -half) x += half;
      if (x > 0) x -= half;
      track.style.transform = 'translate3d(' + x.toFixed(1) + 'px,0,0) skewX(' + (-boost * 0.25).toFixed(2) + 'deg)';
      requestAnimationFrame(loop);
    })(performance.now());
  })();

  /* ---------------- Custom cursor ---------------- */
  if (finePointer && !reduced) {
    root.classList.add('has-cursor');
    const cur = document.getElementById('cursor');
    const label = document.getElementById('cursor-label');
    let x = -100, y = -100, cx = -100, cy = -100;
    window.addEventListener('pointermove', (e) => { x = e.clientX; y = e.clientY; cur.classList.remove('is-hidden'); }, { passive: true });
    document.addEventListener('pointerleave', () => cur.classList.add('is-hidden'));
    (function loop() {
      cx += (x - cx) * 0.2;
      cy += (y - cy) * 0.2;
      cur.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0)';
      requestAnimationFrame(loop);
    })();
    document.addEventListener('pointerover', (e) => {
      const lab = e.target.closest('[data-cursor]');
      const hov = e.target.closest('a, button, label, summary, select, [role="tab"], input[type="checkbox"], input[type="radio"]');
      cur.classList.toggle('is-label', !!lab);
      label.textContent = lab ? lab.getAttribute('data-cursor') : '';
      cur.classList.toggle('is-hover', !lab && !!hov);
      cur.classList.toggle('is-hidden', !!e.target.closest('input[type="text"], textarea'));
    });
  }

  /* ---------------- Magnetic buttons ---------------- */
  if (finePointer && !reduced) {
    document.querySelectorAll('.magnetic').forEach((m) => {
      m.style.transition = 'transform .6s cubic-bezier(.19,1,.22,1)';
      m.addEventListener('pointermove', (e) => {
        const r = m.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        m.style.transform = 'translate(' + (dx * 0.25).toFixed(1) + 'px,' + (dy * 0.35).toFixed(1) + 'px)';
      });
      m.addEventListener('pointerleave', () => { m.style.transform = ''; });
    });
  }

  /* ---------------- Scroll-linked effects ---------------- */
  const preview = document.getElementById('preview');
  const stackCards = Array.from(document.querySelectorAll('.stack-card'));
  const outroArt = document.querySelector('.outro-art');
  const darkSections = Array.from(document.querySelectorAll('[data-theme="dark"]'));
  let ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; update(); });
  }

  function update() {
    const vh = window.innerHeight;

    // Header turns black over inverse sections
    const probe = navH() / 2;
    const dark = darkSections.some((s) => { const r = s.getBoundingClientRect(); return r.top <= probe && r.bottom >= probe; });
    document.body.classList.toggle('header-dark', dark);

    if (reduced) return;

    // Hero preview card grows to full size as it scrolls up
    if (preview) {
      const top = preview.getBoundingClientRect().top;
      const p = clamp((vh * 0.95 - top) / (vh * 0.6), 0, 1);
      preview.style.setProperty('--preview-scale', (0.86 + 0.14 * p).toFixed(4));
    }

    // Stacked cards: the card underneath shrinks and dims as the next one covers it
    stackCards.forEach((card, i) => {
      const next = stackCards[i + 1];
      if (!next) return;
      const r = card.getBoundingClientRect();
      const n = next.getBoundingClientRect();
      const p = clamp(1 - (n.top - r.top) / r.height, 0, 1);
      card.style.setProperty('--s', (1 - 0.05 * p).toFixed(4));
      card.style.setProperty('--b', (1 - 0.45 * p).toFixed(3));
    });

    // Staggered configuration tiles drift at different speeds
    document.querySelectorAll('.work-tile').forEach((tile, i) => {
      const r = tile.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      const centre = r.top + r.height / 2 - vh / 2;
      const speed = i % 2 ? -0.08 : 0.05;
      tile.style.setProperty('--py', (centre * speed).toFixed(1) + 'px');
    });

    // Outro pyramid parallax
    if (outroArt) {
      const r = outroArt.parentElement.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh) outroArt.style.setProperty('--oy', (r.top * 0.12).toFixed(1) + 'px');
    }

    // Words light up as you read through the paragraph
    wordBlocks.forEach((b) => {
      const r = b.elm.getBoundingClientRect();
      const p = clamp((vh * 0.85 - r.top) / (r.height + vh * 0.35), 0, 1);
      const lit = Math.round(p * b.words.length);
      b.words.forEach((w, k) => w.classList.toggle('on', k < lit));
    });
  }

  if (!lenis) window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();

  /* ---------------- Hero scene (canvas) ---------------- */
  const canvas = document.getElementById('preview-canvas');
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    const liveP = document.querySelector('[data-live="p"]');
    let W = 0, H = 0, dpr = 1, running = false, visible = true;
    let mx = 0, my = 0, tmx = 0, tmy = 0;
    const particles = [];
    let spawnAcc = 0, lastT = performance.now();

    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!running) draw(performance.now());
    }

    function livePower() {
      const v = liveP ? parseFloat(liveP.textContent.replace('−', '-')) : NaN;
      return Number.isFinite(v) ? v : null;
    }

    function draw(t) {
      if (!W || !H) return;
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      mx += (tmx - mx) * 0.05; my += (tmy - my) * 0.05;

      const horizon = H * 0.8;
      // Sky
      const sky = ctx.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, '#05060C'); sky.addColorStop(0.6, '#14162E'); sky.addColorStop(1, '#2B2F5E');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

      // Sun path (east -> west), illustrative only
      const period = 18000;
      const u = reduced ? 0.42 : (t % period) / period;
      const th = (166 - 152 * u) * Math.PI / 180;
      const R = Math.min(W * 0.44, H * 0.72);
      const ox = W * 0.62 + mx * 18;
      const sx = ox + R * Math.cos(th);
      const sy = horizon - R * Math.sin(th) + my * 10;

      // Concentric pyramid lines (Cuberto motif)
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (let k = 1; k <= 6; k++) {
        const hw = k * W * 0.11, hh = k * H * 0.13;
        ctx.beginPath(); ctx.moveTo(ox - hw, horizon); ctx.lineTo(ox, horizon - hh); ctx.lineTo(ox + hw, horizon); ctx.stroke();
      }
      ctx.restore();

      // Sun glow and disc
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(W, H) * 0.35);
      glow.addColorStop(0, 'rgba(246,169,59,0.45)'); glow.addColorStop(0.4, 'rgba(246,169,59,0.10)'); glow.addColorStop(1, 'rgba(246,169,59,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
      const disc = ctx.createRadialGradient(sx, sy, 0, sx, sy, 24);
      disc.addColorStop(0, '#FFF1CF'); disc.addColorStop(0.6, '#FFD08A'); disc.addColorStop(1, '#F6A93B');
      ctx.fillStyle = disc; ctx.beginPath(); ctx.arc(sx, sy, 22, 0, Math.PI * 2); ctx.fill();

      // Ground
      const ground = ctx.createLinearGradient(0, horizon, 0, H);
      ground.addColorStop(0, '#0C0D1C'); ground.addColorStop(1, '#000');
      ctx.fillStyle = ground; ctx.fillRect(0, horizon, W, H - horizon);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.moveTo(0, horizon); ctx.lineTo(W, horizon); ctx.stroke();

      // Tracker geometry
      const px = ox, py = horizon - Math.min(H * 0.3, 190);
      const L = Math.min(W * 0.17, 210);
      let ang = Math.atan2(sx - px, py - sy);
      ang = clamp(ang, -0.8, 0.8);   // mechanical limit of the illustrated tracker
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const rot = (x, y) => [px + x * cos - y * sin, py + x * sin + y * cos];
      const left = rot(-L / 2, 0), right = rot(L / 2, 0), centre = [px, py];
      const rl = rot(-L / 2 - L * 0.24, -L * 0.3), rr = rot(L / 2 + L * 0.24, -L * 0.3);

      // Light rays: direct + via reflectors
      ctx.save();
      ctx.setLineDash([6, 8]); ctx.lineDashOffset = -(t / 40);
      ctx.strokeStyle = 'rgba(255,208,138,0.55)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(centre[0], centre[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,208,138,0.28)';
      [[rl, left], [rr, right]].forEach(([refl, end]) => {
        const mxr = (refl[0] + end[0]) / 2, myr = (refl[1] + end[1]) / 2;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(mxr, myr); ctx.lineTo(centre[0], centre[1]); ctx.stroke();
      });
      ctx.restore();

      // Post
      ctx.strokeStyle = '#C9CCE8'; ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(px, horizon); ctx.lineTo(px, py); ctx.stroke();

      // Reflectors (mirror strips)
      ctx.lineWidth = 6;
      const mir = ctx.createLinearGradient(rl[0], rl[1], left[0], left[1]);
      mir.addColorStop(0, '#E8EAF7'); mir.addColorStop(1, '#F6A93B');
      ctx.strokeStyle = mir; ctx.beginPath(); ctx.moveTo(left[0], left[1]); ctx.lineTo(rl[0], rl[1]); ctx.stroke();
      const mir2 = ctx.createLinearGradient(rr[0], rr[1], right[0], right[1]);
      mir2.addColorStop(0, '#E8EAF7'); mir2.addColorStop(1, '#F6A93B');
      ctx.strokeStyle = mir2; ctx.beginPath(); ctx.moveTo(right[0], right[1]); ctx.lineTo(rr[0], rr[1]); ctx.stroke();

      // Panel
      ctx.save();
      ctx.translate(px, py); ctx.rotate(ang);
      const pg = ctx.createLinearGradient(-L / 2, 0, L / 2, 0);
      const shimmer = 0.5 + 0.5 * Math.sin(t / 700);
      pg.addColorStop(0, '#2F4D86'); pg.addColorStop(0.5, 'rgba(120,150,255,' + (0.75 + 0.25 * shimmer).toFixed(2) + ')'); pg.addColorStop(1, '#2F4D86');
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-L / 2, -7, L, 14, 3) : ctx.rect(-L / 2, -7, L, 14); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
      for (let k = 1; k < 6; k++) { const xx = -L / 2 + (L / 6) * k; ctx.beginPath(); ctx.moveTo(xx, -6); ctx.lineTo(xx, 6); ctx.stroke(); }
      ctx.restore();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();

      // Energy particles: panel -> down the post -> along the ground to the reading.
      // Their rate follows the live power value; no data, no particles.
      const pw = livePower();
      if (!reduced && pw !== null && pw > 0) {
        spawnAcc += dt * clamp(pw * 9, 1, 26);
        while (spawnAcc > 1) { spawnAcc -= 1; particles.push({ s: 0, v: 0.18 + Math.random() * 0.12, j: (Math.random() - 0.5) * 6 }); }
      }
      const endX = Math.min(W * 0.1, 80);
      const seg1 = horizon - py, seg2 = px - endX, total = seg1 + seg2;
      ctx.fillStyle = '#FFD08A';
      for (let k = particles.length - 1; k >= 0; k--) {
        const q = particles[k];
        q.s += q.v * dt * (0.6 + clamp(pw || 0, 0, 3));
        if (q.s >= 1) { particles.splice(k, 1); continue; }
        const d = q.s * total;
        let qx, qy;
        if (d < seg1) { qx = px + q.j * 0.3; qy = py + d; } else { qx = px - (d - seg1); qy = horizon + 8 + q.j; }
        ctx.globalAlpha = 1 - q.s * 0.7;
        ctx.beginPath(); ctx.arc(qx, qy, 2.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (particles.length > 300) particles.splice(0, particles.length - 300);
    }

    function frame(t) {
      if (!running) return;
      if (canvas.parentElement.classList.contains('webgl-on')) { running = false; return; }   // 3D scene took over
      draw(t);
      requestAnimationFrame(frame);
    }
    function setRunning(on) {
      if (reduced) { running = false; draw(performance.now()); return; }
      if (on && !running) { running = true; lastT = performance.now(); requestAnimationFrame(frame); }
      if (!on) running = false;
    }

    canvas.parentElement.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      tmx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      tmy = ((e.clientY - r.top) / r.height - 0.5) * 2;
    });
    canvas.parentElement.addEventListener('pointerleave', () => { tmx = 0; tmy = 0; });

    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
    else window.addEventListener('resize', resize);
    resize();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; setRunning(visible); }).observe(canvas);
    } else setRunning(true);
    document.addEventListener('visibilitychange', () => setRunning(!document.hidden && visible));
  }
})();
