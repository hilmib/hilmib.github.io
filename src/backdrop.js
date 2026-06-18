/*
 * Animated geomechanics backdrop
 * ------------------------------------------------------------------
 * A scroll-driven canvas animation that drives the scrollytelling
 * centerpiece. Scroll progress (0..1) is mapped to a physically
 * meaningful parameter:
 *   - "biaxial": axial strain of a plane-strain biaxial specimen — a
 *     prismatic sample, laterally confined by σ₃, that bulges under the
 *     axial load σ₁ and localizes into a single shear band at the
 *     Mohr–Coulomb failure angle (45° + phi/2).
 *
 * Design goals: legible behind text, respectful of prefers-reduced-motion,
 * and cheap on mobile (capped DPR, paused when the tab is hidden).
 *
 * Public API (window.Backdrop): { setMode(mode), getMode() }
 *   mode ∈ { 'off', 'biaxial', 'dem' }  ('dem' reserved for Phase 2)
 */
(function () {
  'use strict';

  var canvas = document.getElementById('backdrop');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var STORAGE_KEY = 'backdrop';
  // Axial strain (%) at peak deviatoric stress. Strain localization (the
  // shear band) initiates here and drives the post-peak softening, so the
  // same value couples qNorm() and the biaxial mesh.
  var PEAK_STRAIN = 5.0;
  var prefersReduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var mode = readMode();
  var dpr = 1;
  var W = 0;
  var H = 0;
  var progress = 0;        // eased animation driver 0..1
  var targetProgress = 0;  // scroll-derived target 0..1
  var rafId = null;
  var running = false;
  var scrollScheduled = false;
  var startTime = (window.performance && performance.now) ? performance.now() : Date.now();

  function readMode() {
    try {
      var m = localStorage.getItem(STORAGE_KEY);
      if (m === 'triaxial') m = 'biaxial'; // migrate legacy stored value
      return m || 'biaxial';
    } catch (e) {
      return 'biaxial';
    }
  }

  function now() {
    return ((window.performance && performance.now) ? performance.now() : Date.now()) - startTime;
  }

  function isDark() {
    return document.documentElement.classList.contains('dark');
  }

  // ── Sizing (DPR-capped for battery/perf) ──
  // The canvas now fills its sticky stage panel, so we measure the element's
  // own box rather than the whole window.
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  // ── Scroll → target strain → progress ──
  // Each narrative ".step" carries a data-strain (axial %). The viewport
  // centre is interpolated between adjacent step centres, so the specimen
  // state tracks the part of the story the reader is currently looking at.
  var EPS_MAX = 18;
  var stepEls = [];

  function collectSteps() {
    stepEls = [].slice.call(document.querySelectorAll('.step'));
  }

  function updateProgress() {
    if (!stepEls.length) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      targetProgress = max > 0 ? clamp01(window.scrollY / max) : 0;
    } else {
      // On the mobile stacked layout the sticky stage occupies the top of
      // the viewport, so track a point lower down where the active step's
      // text actually sits; on any side-by-side layout the columns share
      // the centre.
      var sideBySide = window.matchMedia('(min-width: 1024px)').matches ||
        window.matchMedia('(pointer: coarse) and (orientation: landscape)').matches;
      var focusFrac = sideBySide ? 0.5 : 0.72;
      var focus = window.scrollY + window.innerHeight * focusFrac;
      var prevC = null, prevS = 0, strain = null;
      for (var i = 0; i < stepEls.length; i++) {
        var r = stepEls[i].getBoundingClientRect();
        var center = r.top + window.scrollY + r.height * 0.5;
        var s = parseFloat(stepEls[i].getAttribute('data-strain')) || 0;
        if (i === 0 && focus <= center) { strain = s; break; }
        if (prevC !== null && focus >= prevC && focus <= center) {
          var f = (focus - prevC) / Math.max(1, center - prevC);
          strain = prevS + (s - prevS) * f;
          break;
        }
        prevC = center; prevS = s;
      }
      if (strain === null) strain = prevS; // past the final step
      targetProgress = clamp01(strain / EPS_MAX);
    }
    if (!running) progress = targetProgress;
  }

  // ── Render dispatch ──
  function render() {
    ctx.clearRect(0, 0, W, H);
    if (mode === 'biaxial') drawBiaxial();
    // 'dem' renderer arrives in Phase 2; 'off' clears only.
  }

  // ── Animation loop ──
  function loop() {
    rafId = requestAnimationFrame(loop);
    progress += (targetProgress - progress) * 0.12; // ease toward scroll target
    if (Math.abs(targetProgress - progress) < 0.0004) progress = targetProgress;
    render();
  }

  function start() {
    if (mode === 'off') return;
    if (prefersReduced) {
      // Static representative frame, no continuous motion.
      render();
      return;
    }
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // ── Helpers ──
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }
  function roundRect(x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function arrow(x1, y1, x2, y2, head, color, width) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width || 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    var ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - 0.4), y2 - head * Math.sin(ang - 0.4));
    ctx.lineTo(x2 - head * Math.cos(ang + 0.4), y2 - head * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  function palette() {
    var dark = isDark();
    return {
      soil: dark ? 'rgba(190,170,128,0.08)' : 'rgba(176,150,112,0.13)',
      mesh: dark ? 'rgba(148,163,184,0.18)' : 'rgba(120,113,108,0.20)',
      line: dark ? 'rgba(148,163,184,0.50)' : 'rgba(87,83,78,0.45)',
      grid: dark ? 'rgba(148,163,184,0.22)' : 'rgba(71,85,105,0.18)',
      platen: dark ? 'rgba(148,163,184,0.45)' : 'rgba(71,85,105,0.42)',
      axial: dark ? 'rgba(96,165,250,0.78)' : 'rgba(37,99,235,0.68)',
      confine: dark ? 'rgba(52,211,153,0.72)' : 'rgba(16,185,129,0.62)',
      band: dark ? 'rgba(248,113,113,0.60)' : 'rgba(192,57,43,0.55)',
      vol: dark ? 'rgba(56,189,248,0.62)' : 'rgba(2,132,199,0.55)',
      label: dark ? 'rgba(148,163,184,0.68)' : 'rgba(71,85,105,0.62)',
      bandFill: function (a) {
        return dark
          ? 'rgba(248,113,113,' + (0.55 * a).toFixed(3) + ')'
          : 'rgba(192,57,43,' + (0.5 * a).toFixed(3) + ')';
      },
      // Machined steel, top-lit (vertical) — for end platens, collar, cap nut.
      steelV: function (yTop, yBot) {
        var g = ctx.createLinearGradient(0, yTop, 0, yBot);
        if (dark) {
          g.addColorStop(0, 'rgba(203,213,225,0.96)');
          g.addColorStop(0.45, 'rgba(148,163,184,0.92)');
          g.addColorStop(1, 'rgba(71,85,105,0.96)');
        } else {
          g.addColorStop(0, 'rgba(241,245,249,0.98)');
          g.addColorStop(0.45, 'rgba(203,213,225,0.95)');
          g.addColorStop(1, 'rgba(100,116,139,0.96)');
        }
        return g;
      },
      // Cylindrical highlight (horizontal) — for the round loading-piston shaft.
      steelH: function (xLeft, xRight) {
        var g = ctx.createLinearGradient(xLeft, 0, xRight, 0);
        if (dark) {
          g.addColorStop(0, 'rgba(71,85,105,0.96)');
          g.addColorStop(0.5, 'rgba(203,213,225,0.96)');
          g.addColorStop(1, 'rgba(71,85,105,0.96)');
        } else {
          g.addColorStop(0, 'rgba(100,116,139,0.96)');
          g.addColorStop(0.5, 'rgba(241,245,249,0.98)');
          g.addColorStop(1, 'rgba(100,116,139,0.96)');
        }
        return g;
      },
      pedestal: dark ? 'rgba(51,65,85,0.95)' : 'rgba(71,85,105,0.92)'
    };
  }

  // ── Biaxial (plane-strain) renderer (deformable FE-style mesh) ──
  // Scroll progress maps to axial strain. The prismatic specimen is a
  // deformable mesh that bulges under the axial load and localizes into a
  // single shear band at the Mohr–Coulomb plane angle θ = 45° + φ/2.
  function drawBiaxial() {
    var p = palette();
    var t = progress;            // scroll fraction 0..1
    var epsMaxPct = 18;          // max axial strain (%)
    var epsPct = t * epsMaxPct;  // current axial strain (%)
    var epsA = epsPct / 100;     // ratio

    var narrow = W < 560;
    // Centerpiece: the specimen owns its sticky stage panel, so it is sized
    // boldly and centred (narrative text lives in the separate column).
    var H0 = Math.max(160, Math.min(H * 0.56, 470));
    var W0 = H0 * 0.5; // ~2:1 height-to-width prismatic biaxial sample
    // On a wide canvas the specimen sits LEFT of centre so the stress–strain
    // plot can sit beside it on the right; otherwise centred. Touch devices in
    // landscape get the same side-by-side treatment even though the split
    // stage canvas is narrower than a desktop one.
    var wide = W >= 600 ||
      (typeof matchMedia === 'function' &&
       matchMedia('(pointer: coarse) and (orientation: landscape)').matches &&
       W >= 340);
    var cx = wide ? W * 0.30 : W * 0.5;
    var baseY = H * 0.5 + H0 / 2; // fixed pedestal (bottom); top platen descends

    var phiDeg = 34;
    var theta = (45 + phiDeg / 2) * Math.PI / 180; // failure-plane angle from horizontal

    // Volumetric strain (contraction → dilation) drives lateral expansion:
    // W = W0 * sqrt((1 + εv) / (1 - εa)).
    var epsV = volStrainRatio(epsPct);
    var curH = H0 * (1 - epsA);
    var curW = W0 * Math.sqrt(Math.max(0.2, 1 + epsV) / Math.max(0.2, 1 - epsA));

    // Idle "breathing" before loading begins (skipped for reduced motion).
    var breathe = prefersReduced ? 0 : Math.sin(now() / 1500) * (1 - clamp01(t * 3)) * 0.01;
    curH *= (1 - breathe);

    // Shear failure localizes only AFTER peak stress: the band initiates at
    // the peak strain and develops through the softening regime.
    var loc = clamp01((epsPct - PEAK_STRAIN) / (13 - PEAK_STRAIN));

    var cols = narrow ? 12 : 16;
    var rows = narrow ? 24 : 32;

    // Slip-plane geometry (screen coords, y down): line dir up-right, normal n.
    var dx = Math.cos(theta), dy = -Math.sin(theta);
    var nx = Math.sin(theta), ny = Math.cos(theta);
    var planeCx = cx, planeCy = baseY - curH * 0.5;
    // The shear band sharpens as it matures: wide & diffuse at onset (peak),
    // narrowing into a crisp slip surface through the softening regime.
    var bandW = W0 * (0.26 - 0.15 * loc);
    var slipMax = W0 * 0.19;
    var topY = baseY - curH;

    // Build the deformed mesh: barrelling + a shear band whose two halves
    // slide past each other (rigid offset) along the failure plane.
    var nodes = [];
    for (var r = 0; r <= rows; r++) {
      var rowArr = [];
      var yf = r / rows;
      for (var c = 0; c <= cols; c++) {
        var xf = c / cols;
        var fx = cx - curW / 2 + xf * curW;
        var fy = baseY - yf * curH;
        var bulge = Math.sin(yf * Math.PI); // max at mid-height, 0 at platens
        // Barrelling grows with load but eases once the band takes over, so
        // post-peak deformation localizes onto the slip plane (see photo).
        var barrelAmt = (epsPct / epsMaxPct) * (1 - 0.3 * loc);
        fx += (xf - 0.5) * curW * 0.16 * bulge * barrelAmt;
        // Rigid platens restrain slip at the specimen ends (friction cone):
        // taper the shear-band slide to zero near the top/bottom contacts.
        var endC = clamp01(Math.min(yf, 1 - yf) / 0.18);
        endC = endC * endC * (3 - 2 * endC); // smoothstep
        var s = 0;
        if (loc > 0) {
          var dist = (fx - planeCx) * nx + (fy - planeCy) * ny;
          var u = dist / bandW;
          // The two halves slide PAST each other along the plane: a smooth
          // step (tanh) gives a true relative offset that is retained away
          // from the band, so the blocks visibly shear and the offset grows
          // with strain — exactly the progression in the reference photo.
          var slide = Math.tanh(u) * slipMax * loc * endC;
          fx += slide * dx;
          fy += slide * dy;
          // Shading stays Gaussian-localized so ONLY the band is coloured;
          // it narrows + intensifies as bandW shrinks and loc grows.
          s = Math.exp(-u * u) * loc * endC;
        }
        rowArr.push({ x: fx, y: fy, s: s });
      }
      nodes.push(rowArr);
    }

    ctx.save();
    ctx.globalAlpha = narrow ? 0.8 : 0.96;

    // ── End platens + loading piston (biaxial cell hardware) ──
    var capW = curW * 1.06 + 4;           // end-plate width (just over specimen)
    var capX = cx - capW / 2;
    var plateH = 12;                      // end-plate thickness
    var ramLen = Math.min(21, H * 0.03);  // piston shaft length
    var collarH = 4, collarW = 18;        // shaft collar
    var nutH = 9, nutW = 30;              // piston cap / nut head
    var shaftTop = topY - plateH - ramLen;
    var nutTopY = shaftTop - collarH - nutH;
    var baseH = 14;                       // pedestal base block
    var pedBottomY = baseY + plateH + baseH;

    ctx.lineWidth = 1;
    ctx.strokeStyle = p.line;

    // Top end platen (descends with the applied axial strain).
    ctx.fillStyle = p.steelV(topY - plateH, topY);
    roundRect(capX, topY - plateH, capW, plateH, 3);
    ctx.fill();
    ctx.stroke();

    // Loading piston: cylindrical shaft + collar + cap nut.
    ctx.fillStyle = p.steelH(cx - 5, cx + 5);
    ctx.fillRect(cx - 5, shaftTop, 10, ramLen);
    ctx.fillStyle = p.steelV(shaftTop - collarH, shaftTop);
    roundRect(cx - collarW / 2, shaftTop - collarH, collarW, collarH, 1.5);
    ctx.fill();
    ctx.fillStyle = p.steelV(nutTopY, shaftTop - collarH);
    roundRect(cx - nutW / 2, nutTopY, nutW, nutH, 2);
    ctx.fill();
    ctx.stroke();

    // Bottom end platen (fixed) over a heavier pedestal base.
    ctx.fillStyle = p.steelV(baseY, baseY + plateH);
    roundRect(capX, baseY, capW, plateH, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = p.pedestal;
    roundRect(cx - (capW + 8) / 2, baseY + plateH, capW + 8, baseH, 2);
    ctx.fill();
    ctx.stroke();

    // Specimen body fill (boundary loop of the mesh)
    ctx.beginPath();
    ctx.moveTo(nodes[0][0].x, nodes[0][0].y);
    for (var c1 = 1; c1 <= cols; c1++) ctx.lineTo(nodes[0][c1].x, nodes[0][c1].y);
    for (var r1 = 1; r1 <= rows; r1++) ctx.lineTo(nodes[r1][cols].x, nodes[r1][cols].y);
    for (var c2 = cols - 1; c2 >= 0; c2--) ctx.lineTo(nodes[rows][c2].x, nodes[rows][c2].y);
    for (var r2 = rows - 1; r2 >= 1; r2--) ctx.lineTo(nodes[r2][0].x, nodes[r2][0].y);
    ctx.closePath();
    ctx.fillStyle = p.soil;
    ctx.fill();

    // Shear-strain heatmap on band cells
    if (loc > 0) {
      for (var r3 = 0; r3 < rows; r3++) {
        for (var c3 = 0; c3 < cols; c3++) {
          var a = nodes[r3][c3], b = nodes[r3 + 1][c3], cc = nodes[r3 + 1][c3 + 1], d = nodes[r3][c3 + 1];
          var avg = (a.s + b.s + cc.s + d.s) / 4;
          if (avg > 0.06) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.lineTo(cc.x, cc.y);
            ctx.lineTo(d.x, d.y);
            ctx.closePath();
            ctx.fillStyle = p.bandFill(avg);
            ctx.fill();
          }
        }
      }
    }

    // Mesh lines (deformation field)
    ctx.strokeStyle = p.mesh;
    ctx.lineWidth = 1;
    for (var r4 = 0; r4 <= rows; r4++) {
      ctx.beginPath();
      ctx.moveTo(nodes[r4][0].x, nodes[r4][0].y);
      for (var c4 = 1; c4 <= cols; c4++) ctx.lineTo(nodes[r4][c4].x, nodes[r4][c4].y);
      ctx.stroke();
    }
    for (var c5 = 0; c5 <= cols; c5++) {
      ctx.beginPath();
      ctx.moveTo(nodes[0][c5].x, nodes[0][c5].y);
      for (var r5 = 1; r5 <= rows; r5++) ctx.lineTo(nodes[r5][c5].x, nodes[r5][c5].y);
      ctx.stroke();
    }

    // Specimen lateral boundaries (confined faces)
    ctx.strokeStyle = p.line;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(nodes[0][0].x, nodes[0][0].y);
    for (var r6 = 1; r6 <= rows; r6++) ctx.lineTo(nodes[r6][0].x, nodes[r6][0].y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(nodes[0][cols].x, nodes[0][cols].y);
    for (var r7 = 1; r7 <= rows; r7++) ctx.lineTo(nodes[r7][cols].x, nodes[r7][cols].y);
    ctx.stroke();


    // Axial stress arrows (σ1), grow with load — applied through the piston
    // cap (top) and resisted at the pedestal base (bottom).
    var aLen = lerp(16, 38, t);
    arrow(cx, nutTopY - 10 - aLen, cx, nutTopY - 10, 7, p.axial, 2);
    arrow(cx, pedBottomY + 10 + aLen, cx, pedBottomY + 10, 7, p.axial, 2);

    // Lateral confining stress arrows (σ3), constant — anchored to the ACTUAL
    // deformed boundary nodes so they always sit just outside the bulged and
    // sheared edge (never inside the specimen at full deformation).
    var fr = [0.25, 0.5, 0.75];
    var lblX = cx + curW / 2 + 34, lblY = baseY - curH * 0.5 + 4;
    for (var fi = 0; fi < 3; fi++) {
      var rr = Math.round(fr[fi] * rows);
      var ln = nodes[rr][0];      // left boundary node
      var rn = nodes[rr][cols];   // right boundary node
      arrow(ln.x - 28, ln.y, ln.x - 6, ln.y, 6, p.confine, 1.5);
      arrow(rn.x + 28, rn.y, rn.x + 6, rn.y, 6, p.confine, 1.5);
      if (fi === 1) { lblX = rn.x + 34; lblY = rn.y + 4; }
    }

    // Labels
    ctx.fillStyle = p.label;
    ctx.font = '500 13px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('σ\u2081', cx, nutTopY - 10 - aLen - 8);
    ctx.textAlign = 'left';
    ctx.fillText('σ\u2083', lblX, lblY);

    ctx.restore();

    // Stress–strain inset (q–εa with εv overlay). On wide canvases it sits to
    // the RIGHT of the specimen; plotX is the left edge of that free zone.
    // The gap is tighter on narrow (mobile-landscape) canvases where space
    // is at a premium.
    var plotX = cx + W0 * 0.58 + (narrow ? 56 : 80);
    drawStressStrainInset(p, epsPct, epsMaxPct, narrow, wide, plotX);
  }

  // Volumetric strain (ratio) vs axial strain (%). Dense-soil response,
  // smoothed to mimic a clean lab curve (no measurement noise):
  //   - a small initial CONTRACTION (negative) during early loading,
  //   - then DILATION whose RATE (slope dεv/dεa) is MAXIMUM exactly at the
  //     peak-stress strain — maximum dilatancy at peak, per Rowe's
  //     stress-dilatancy theory,
  //   - easing to a constant-volume critical state (plateau) at large strain.
  function volStrainRatio(epsPct) {
    var peak = PEAK_STRAIN;
    var wDil = 2.2;     // dilation transition half-width (steepness)
    var dilAmp = 1.31;  // sets the dilation plateau (~2.6%)
    var conAmp = 0.95;  // initial contraction magnitude
    var kCon = 1.5;     // contraction decay length (% strain)
    // Dilation S-curve: a tanh whose steepest point (max rate) lands at
    // εa = peak; offset so εv(0) = 0 and it rises to a plateau afterwards.
    var dil = dilAmp * (Math.tanh((epsPct - peak) / wDil) + Math.tanh(peak / wDil));
    // Transient contraction that fades once the soil starts to dilate.
    var con = conAmp * epsPct * Math.exp(-epsPct / kCon);
    var vPct = dil - con;
    if (vPct < -1.2) vPct = -1.2;
    if (vPct > 3.2) vPct = 3.2;
    return vPct / 100;
  }

  // Normalized deviatoric stress q/q_peak vs axial strain (%):
  // hyperbolic hardening to the peak, then softening toward a residual once
  // the shear band has formed (same PEAK_STRAIN as the localization onset,
  // so softening and band growth begin together, just after peak).
  function qNorm(epsPct) {
    var peak = PEAK_STRAIN;
    if (epsPct <= peak) {
      var ratio = epsPct / peak;
      return 1.1 * ratio / (0.1 + ratio);
    }
    var rres = 0.6;
    return rres + (1 - rres) * Math.exp(-(epsPct - peak) * 0.22);
  }

  function drawStressStrainInset(p, epsPct, epsMaxPct, narrow, wide, plotX) {
    var bx, by, bw, bh;
    if (wide) {
      // Desktop: the specimen sits left-of-centre, so the plot lives in the
      // free space to its RIGHT (plotX), vertically centred — never overlapping.
      var rightMargin = Math.round(W * 0.045);
      bw = Math.round(Math.min(260, W - plotX - rightMargin));
      bh = Math.round(Math.min(280, Math.max(150, H * 0.34)));
      bx = Math.round(plotX);
      by = Math.round((H - bh) / 2);
    } else {
      // Narrow / mobile: tuck a compact plot into the bottom-left corner.
      var pad = Math.max(14, Math.round(W * 0.045));
      bw = Math.round(Math.min(190, Math.max(110, W * 0.42)));
      bh = Math.round(Math.min(150, Math.max(86, H * 0.30)));
      bx = pad;
      by = H - bh - pad;
    }

    ctx.save();
    ctx.globalAlpha = narrow ? 0.72 : 0.96;

    // axes (left = q, bottom = εa)
    ctx.strokeStyle = p.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx, by + bh);
    ctx.lineTo(bx + bw, by + bh);
    ctx.stroke();

    // secondary right axis for the dashed volumetric-strain curve
    ctx.strokeStyle = p.vol;
    ctx.beginPath();
    ctx.moveTo(bx + bw, by);
    ctx.lineTo(bx + bw, by + bh);
    ctx.stroke();

    var curEps = clamp01(epsPct / epsMaxPct) * epsMaxPct;
    var steps = 72;
    var qx = bx, qy = by + bh;

    // q–εa curve, traced up to the current strain
    ctx.strokeStyle = p.axial;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i <= steps; i++) {
      var e = (i / steps) * curEps;
      var q = qNorm(e);
      var x = bx + (e / epsMaxPct) * (bw - 6);
      var y = by + bh - q * (bh - 12);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      qx = x;
      qy = y;
    }
    ctx.stroke();

    // εv–εa curve (volumetric), dashed and faint
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * 0.8;
    ctx.strokeStyle = p.vol;
    ctx.lineWidth = 1.3;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    var vMin = -1.2, vMax = 3.2;
    var vx = bx, vy = by + bh;
    for (var j = 0; j <= steps; j++) {
      var e2 = (j / steps) * curEps;
      var v = volStrainRatio(e2) * 100;
      var vn = (v - vMin) / (vMax - vMin);
      var x2 = bx + (e2 / epsMaxPct) * (bw - 6);
      var y2 = by + bh - vn * (bh - 12) * 0.5;
      if (j === 0) ctx.moveTo(x2, y2);
      else ctx.lineTo(x2, y2);
      vx = x2;
      vy = y2;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // current-state markers: solid on the q curve, hollow on the εv curve
    if (epsPct > 0.1) {
      ctx.fillStyle = p.band;
      ctx.beginPath();
      ctx.arc(qx, qy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.vol;
      ctx.beginPath();
      ctx.arc(vx, vy, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // labels
    ctx.fillStyle = p.label;
    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('q', bx - 2, by - 6);
    ctx.textAlign = 'center';
    ctx.fillText('\u03b5\u2090', bx + bw / 2, by + bh + 14);
    // secondary axis label (volumetric strain εv)
    ctx.fillStyle = p.vol;
    ctx.textAlign = 'right';
    ctx.fillText('\u03b5\u1d65', bx + bw + 2, by - 6);
    ctx.restore();
  }

  // ── Public API ──
  function setMode(m) {
    mode = m;
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch (e) {}
    if (m === 'off') {
      stop();
      ctx.clearRect(0, 0, W, H);
      return;
    }
    updateProgress();
    if (running) render();
    else start();
  }

  function getMode() {
    return mode;
  }

  // ── Events ──
  function onScroll() {
    updateProgress();
    if (running) return; // continuous loop already redraws
    if (!scrollScheduled) {
      scrollScheduled = true;
      requestAnimationFrame(function () {
        render();
        scrollScheduled = false;
      });
    }
  }

  function onVisibility() {
    if (document.hidden) stop();
    else if (mode !== 'off') start();
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  // Some mobile browsers fire 'orientationchange' before the new viewport
  // metrics settle, so re-measure on the next frame as well.
  window.addEventListener('orientationchange', function () {
    requestAnimationFrame(resize);
  }, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);

  window.Backdrop = { setMode: setMode, getMode: getMode };

  // ── Init ──
  collectSteps();
  resize();
  updateProgress();
  start();
})();
