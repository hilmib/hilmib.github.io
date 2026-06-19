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
 *   - "dem": a scroll-driven granular slope collapse, drawn with the same
 *     canvas frame as the biaxial centerpiece.
 *
 * Design goals: legible behind text, respectful of prefers-reduced-motion,
 * and cheap on mobile (capped DPR, paused when the tab is hidden).
 *
 * Public API (window.Backdrop): { setMode(mode), getMode() }
 *   mode ∈ { 'off', 'biaxial', 'dem' }
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
      if (m !== 'off' && m !== 'biaxial' && m !== 'dem') m = 'biaxial';
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

  // True when the layout shows the specimen beside the narrative. Keep this in
  // sync with the scrollytelling media queries in index.html.
  function isSideBySide() {
    if (document.body.classList.contains('stage-hidden')) return false;
    if (typeof matchMedia !== 'function') return false;
    return matchMedia('(min-width: 1024px)').matches ||
      matchMedia('(min-width: 640px) and (max-width: 1023px) and (min-height: 480px) and (min-aspect-ratio: 1/1)').matches;
  }

  function isDesktopSplit() {
    return typeof matchMedia === 'function' && matchMedia('(min-width: 1024px)').matches;
  }

  // ── Figure metrics: the specimen+plot cluster, driven purely by height ──
  // The specimen height follows the page (canvas) height; everything else —
  // specimen width, σ₃-arrow clearance, the gap, and the height-locked plot —
  // is derived from it. So the figure has ONE natural width (figureW) that does
  // NOT depend on the canvas width. We size the canvas to figureW (see
  // fitFrame) so it hugs the figure perfectly, and draw with the same numbers
  // so the two never disagree. Left→right: leftPad · specimen · σ₃ arm · gap ·
  // plot · rightPad.
  function biaxialMetrics(Hpx) {
    var H0 = Math.max(160, Math.min(Hpx * 0.56, 470));
    var W0 = H0 * 0.5;            // ~2:1 prismatic specimen
    var specHalf = W0 * 0.6;     // half-width incl. barrel bulge at full strain
    var armReach = 28;           // σ₃ arrow length beyond the boundary node
    var leftPad = specHalf + 34; // left σ₃ arrow + σ₁ label clearance
    var gap = W0 * 0.45;         // specimen → plot separation
    var plotW = H0 * 0.75;       // height-locked plot (height = 0.8·plotW = H0·0.6)
    var rightPad = 24;           // εᵥ axis-label clearance
    var cx = leftPad;                                  // specimen centre
    var plotX = cx + specHalf + armReach + gap;        // plot left edge
    var figureW = plotX + plotW + rightPad;            // natural cluster width
    return { H0: H0, W0: W0, cx: cx, plotX: plotX, plotW: plotW, figureW: figureW };
  }

  function heightForFigureWidth(targetW, maxH) {
    var low = 180;
    var high = Math.max(low, maxH);
    for (var i = 0; i < 18; i++) {
      var mid = (low + high) / 2;
      if (biaxialMetrics(mid).figureW > targetW) high = mid;
      else low = mid;
    }
    return Math.min(maxH, Math.max(260, high));
  }

  // Constrain the stage frame to the specimen+plot cluster. On desktop the
  // frame gets the figure's natural width unless the text column needs room;
  // on compact landscape it keeps the grid column width. In both cases, when
  // width is the limiting dimension, the frame height is reduced as well so the
  // canvas does not become a tall empty panel around a scaled-down figure.
  function fitFrame() {
    var frame = canvas.parentNode;        // .stage-frame
    if (!frame) return;
    frame.style.width = '';
    frame.style.height = '';
    if (!isSideBySide()) return;

    var hPx = frame.getBoundingClientRect().height;
    var naturalW = biaxialMetrics(hPx).figureW;

    if (!isDesktopSplit()) {
      var compactW = frame.getBoundingClientRect().width;
      if (compactW > 0 && compactW < naturalW - 1) {
        frame.style.height = heightForFigureWidth(compactW, hPx) + 'px';
      }
      return;
    }

    var targetW = naturalW;
    var container = document.querySelector('.scrolly'); // the grid box
    var narrative = document.querySelector('.scrolly__narrative');
    if (container && narrative) {
      var gap = parseFloat(getComputedStyle(container).columnGap) || 0;
      var avail = container.clientWidth - gap - narrative.getBoundingClientRect().width;
      if (avail > 0) targetW = Math.min(targetW, avail);
    }

    var targetH = hPx;
    if (targetW < naturalW - 1) {
      targetH = heightForFigureWidth(targetW, hPx);
      frame.style.height = targetH + 'px';
    }
    frame.style.width = Math.min(targetW, biaxialMetrics(targetH).figureW) + 'px';
  }

  // ── Sizing (DPR-capped for battery/perf) ──
  // The canvas now fills its sticky stage panel, so we measure the element's
  // own box rather than the whole window.
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    fitFrame();                  // size the frame to the figure, then measure
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateProgress();
    if (mode === 'off' || !isSideBySide()) {
      stop();
      ctx.clearRect(0, 0, W, H);
      return;
    }
    render();
    if (!document.hidden) start();
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
      var sideBySide = isSideBySide();
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
    else if (mode === 'dem') drawDEMSlope();
    // 'off' clears only.
  }

  // ── Animation loop ──
  function loop() {
    rafId = requestAnimationFrame(loop);
    progress += (targetProgress - progress) * 0.12; // ease toward scroll target
    if (Math.abs(targetProgress - progress) < 0.0004) progress = targetProgress;
    render();
  }

  function start() {
    if (mode === 'off' || !isSideBySide()) return;
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
  function smoothstep(edge0, edge1, x) {
    var u = clamp01((x - edge0) / Math.max(0.0001, edge1 - edge0));
    return u * u * (3 - 2 * u);
  }
  function seededRand(seed) {
    var s = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
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
      soil: dark ? 'rgba(190,170,128,0.10)' : 'rgba(176,150,112,0.16)',
      mesh: dark ? 'rgba(148,163,184,0.24)' : 'rgba(120,113,108,0.28)',
      line: dark ? 'rgba(203,213,225,0.58)' : 'rgba(71,85,105,0.56)',
      grid: dark ? 'rgba(148,163,184,0.32)' : 'rgba(71,85,105,0.28)',
      platen: dark ? 'rgba(203,213,225,0.56)' : 'rgba(71,85,105,0.50)',
      axial: dark ? 'rgba(96,165,250,0.88)' : 'rgba(37,99,235,0.76)',
      confine: dark ? 'rgba(52,211,153,0.82)' : 'rgba(5,150,105,0.70)',
      band: dark ? 'rgba(248,113,113,0.68)' : 'rgba(185,28,28,0.62)',
      vol: dark ? 'rgba(56,189,248,0.76)' : 'rgba(2,132,199,0.68)',
      label: dark ? 'rgba(203,213,225,0.76)' : 'rgba(51,65,85,0.76)',
      bandFill: function (a) {
        return dark
          ? 'rgba(248,113,113,' + (0.62 * a).toFixed(3) + ')'
          : 'rgba(185,28,28,' + (0.56 * a).toFixed(3) + ')';
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

  var DEM_REF_W = 700;
  var DEM_REF_H = 420;
  var DEM_FLOOR_LEFT = -90;
  var DEM_X_RIGHT = 658;
  var DEM_Y_FLOOR = 378;
  var DEM_Y_CEILING = 28;
  var DEM_WEDGE_START_X = 352;
  var DEM_WEDGE_TOP_Y = 48;
  var DEM_MAX_FRAME = 185;
  var demState = null;

  function demPalette() {
    var dark = isDark();
    return {
      floor: dark ? 'rgba(148,163,184,0.18)' : 'rgba(100,116,139,0.20)',
      shadowCore: dark ? 'rgba(0,0,0,0.18)' : 'rgba(15,23,42,0.07)',
      shadowFade: dark ? 'rgba(0,0,0,0)' : 'rgba(15,23,42,0)',
      stroke: dark ? 'rgba(15,23,42,0.48)' : 'rgba(68,64,60,0.54)',
      mark: dark ? 'rgba(15,23,42,0.42)' : 'rgba(41,37,36,0.38)',
      grains: dark
        ? ['rgba(245,158,11,0.72)', 'rgba(217,119,6,0.70)', 'rgba(180,83,9,0.68)', 'rgba(254,243,199,0.70)', 'rgba(214,211,209,0.64)']
        : ['rgba(217,119,6,0.52)', 'rgba(180,83,9,0.50)', 'rgba(146,64,14,0.46)', 'rgba(245,222,179,0.56)', 'rgba(168,162,158,0.48)']
    };
  }

  function demSceneBox() {
    var ratio = DEM_REF_W / DEM_REF_H;
    var sceneW = Math.min(W * 0.90, H * 0.78 * ratio);
    var sceneH = sceneW / ratio;
    if (sceneH > H * 0.76) {
      sceneH = H * 0.76;
      sceneW = sceneH * ratio;
    }
    return {
      x: (W - sceneW) * 0.5,
      y: (H - sceneH) * 0.5 + H * 0.02,
      w: sceneW,
      h: sceneH,
      scale: sceneW / DEM_REF_W
    };
  }

  function demX(scene, x) { return scene.x + x * scene.scale; }
  function demY(scene, y) { return scene.y + y * scene.scale; }

  function makeDemParticles() {
    var particles = [];
    var radius = 9.6;
    var dx = radius * 2.04;
    var dy = radius * 1.77;
    var slope = (DEM_Y_FLOOR - DEM_WEDGE_TOP_Y) / (DEM_X_RIGHT - DEM_WEDGE_START_X);
    var id = 1;

    for (var rowIndex = 0; rowIndex < 23; rowIndex++) {
      var y = DEM_Y_FLOOR - radius - rowIndex * dy;
      var stagger = rowIndex % 2 ? radius : 0;
      for (var x = DEM_WEDGE_START_X + radius + stagger; x < DEM_X_RIGHT - radius; x += dx) {
        var limitY = DEM_Y_FLOOR - slope * (x - DEM_WEDGE_START_X);
        if (y < limitY && rowIndex !== 0) continue;
        var seed = id * 13.7;
        particles.push({
          id: id,
          x: x,
          y: y,
          px: x,
          py: y,
          vx: 0,
          vy: 0,
          radius: radius * (0.90 + seededRand(seed) * 0.18),
          angle: seededRand(seed + 4.1) * Math.PI * 2,
          colorIndex: Math.floor(seededRand(seed + 8.2) * 5),
          fixed: false
        });
        id++;
      }
    }
    return particles;
  }

  function cloneDemFrame(particles) {
    var frame = [];
    for (var i = 0; i < particles.length; i++) {
      frame.push({ x: particles[i].x, y: particles[i].y, angle: particles[i].angle });
    }
    return frame;
  }

  function createDemState() {
    var particles = makeDemParticles();
    return { particles: particles, history: [cloneDemFrame(particles)] };
  }

  function runDemPhysicsStep(particles, frameIndex) {
    var substeps = 5;
    var release = smoothstep(0, 48, frameIndex);
    var settle = smoothstep(72, DEM_MAX_FRAME, frameIndex);
    for (var substep = 0; substep < substeps; substep++) {
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        if (p.fixed) continue;
        p.px = p.x;
        p.py = p.y;
        var heightFrac = clamp01((DEM_Y_FLOOR - p.y) / (DEM_Y_FLOOR - DEM_WEDGE_TOP_Y));
        var freeFace = clamp01((DEM_X_RIGHT - p.x) / (DEM_X_RIGHT - DEM_WEDGE_START_X));
        p.vy += 0.16;
        p.vx -= release * (0.0006 + 0.0045 * heightFrac) * freeFace;
        p.x += p.vx;
        p.y += p.vy;
      }

      for (var aIndex = 0; aIndex < particles.length; aIndex++) {
        var a = particles[aIndex];
        for (var bIndex = aIndex + 1; bIndex < particles.length; bIndex++) {
          var b = particles[bIndex];
          var dx = b.x - a.x;
          var dy = b.y - a.y;
          var minDist = a.radius + b.radius;
          var distSq = dx * dx + dy * dy;
          if (distSq >= minDist * minDist) continue;

          var dist = Math.sqrt(distSq) || 0.001;
          var overlap = (minDist - dist) * 0.78;
          var nx = dx / dist;
          var ny = dy / dist;
          var aw = a.fixed ? 0 : 1;
          var bw = b.fixed ? 0 : 1;
          var totalWeight = aw + bw;
          if (totalWeight <= 0) continue;

          if (aw) {
            a.x -= nx * overlap * (aw / totalWeight);
            a.y -= ny * overlap * (aw / totalWeight);
          }
          if (bw) {
            b.x += nx * overlap * (bw / totalWeight);
            b.y += ny * overlap * (bw / totalWeight);
          }

          var tangent = (b.vx - a.vx) * -ny + (b.vy - a.vy) * nx;
          var frictionMove = Math.max(-minDist * 0.14, Math.min(minDist * 0.14, tangent * 0.58));
          var tx = -ny;
          var ty = nx;
          if (aw) {
            a.x += tx * frictionMove * (aw / totalWeight);
            a.y += ty * frictionMove * (aw / totalWeight);
          }
          if (bw) {
            b.x -= tx * frictionMove * (bw / totalWeight);
            b.y -= ty * frictionMove * (bw / totalWeight);
          }
          if (!a.fixed) a.angle += tangent * 0.010;
          if (!b.fixed) b.angle -= tangent * 0.010;
        }
      }

      for (var j = 0; j < particles.length; j++) {
        var q = particles[j];
        if (q.fixed) continue;
        if (q.y + q.radius > DEM_Y_FLOOR) {
          q.y = DEM_Y_FLOOR - q.radius;
          q.vy = 0;
          q.vx *= 0.34 - 0.08 * settle;
          if (Math.abs(q.vx) < 0.18) q.vx = 0;
          q.angle += q.vx * 0.025;
        }
        if (q.x + q.radius > DEM_X_RIGHT) {
          q.x = DEM_X_RIGHT - q.radius;
          q.vx = Math.min(0, q.vx) * 0.02;
          q.vy *= 0.48;
        }
      }

      for (var k = 0; k < particles.length; k++) {
        var grain = particles[k];
        if (grain.fixed) continue;
        grain.vx = (grain.x - grain.px) * (0.90 - 0.08 * settle);
        grain.vy = (grain.y - grain.py) * 0.94;
      }
    }
  }

  function getDemFrame(frameIndex) {
    if (!demState) demState = createDemState();
    var target = Math.max(0, Math.min(DEM_MAX_FRAME, frameIndex));
    while (demState.history.length <= target) {
      runDemPhysicsStep(demState.particles, demState.history.length);
      demState.history.push(cloneDemFrame(demState.particles));
    }
    return demState.history[target];
  }

  function drawDemParticle(scene, particle, frame, palette, alpha) {
    var x = demX(scene, frame.x);
    var y = demY(scene, frame.y);
    var r = particle.radius * scene.scale;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y);
    ctx.rotate(frame.angle);
    ctx.fillStyle = palette.grains[particle.colorIndex % palette.grains.length];
    ctx.strokeStyle = palette.stroke;
    ctx.lineWidth = Math.max(0.8, r * 0.12);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = palette.mark;
    ctx.lineWidth = Math.max(0.7, r * 0.11);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r * 0.72, 0);
    ctx.stroke();
    ctx.restore();
  }

  function drawDemContactSurface(x1, y1, x2, y2, sideX, sideY, sx, palette) {
    var shadowDepth = Math.max(7, sx * 13);
    var contactShadow = ctx.createLinearGradient(
      x1,
      y1,
      x1 + sideX * shadowDepth,
      y1 + sideY * shadowDepth
    );
    contactShadow.addColorStop(0, palette.shadowCore);
    contactShadow.addColorStop(1, palette.shadowFade);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.fillStyle = contactShadow;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 + sideX * shadowDepth, y2 + sideY * shadowDepth);
    ctx.lineTo(x1 + sideX * shadowDepth, y1 + sideY * shadowDepth);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = palette.floor;
    ctx.lineWidth = Math.max(0.8, sx * 1.7);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  function demFrameBounds(frame, particles) {
    var minX = Infinity;
    var minY = Infinity;
    var rightMinY = Infinity;
    var rightBandX = DEM_X_RIGHT - 170;

    for (var i = 0; i < frame.length; i++) {
      var radius = particles[i].radius;
      var left = frame[i].x - radius;
      var top = frame[i].y - radius;
      if (left < minX) minX = left;
      if (top < minY) minY = top;
      if (frame[i].x > rightBandX && top < rightMinY) rightMinY = top;
    }

    return {
      minX: minX,
      pileTopY: isFinite(rightMinY) ? rightMinY : minY
    };
  }

  // ── DEM slope renderer ──
  // The scroll position scrubs a cached PBD timeline: frame 0 is the packed
  // triangular slope, later frames are generated by gravity/contact resolution.
  function drawDEMSlope() {
    var p = demPalette();
    var scene = demSceneBox();
    var collapse = smoothstep(0.03, 0.96, progress);
    var frameIndex = Math.round(collapse * DEM_MAX_FRAME);
    var frame = getDemFrame(frameIndex);
    var particles = demState.particles;
    var sx = scene.scale;
    var bounds = demFrameBounds(frame, particles);
    var floorStart = Math.max(DEM_FLOOR_LEFT, Math.min(DEM_WEDGE_START_X - 24, bounds.minX - 18));
    var wallTop = Math.min(DEM_Y_FLOOR - 46, Math.max(DEM_Y_CEILING, bounds.pileTopY - 24));

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = W < 560 ? 0.82 : 0.94;

    var floorY = demY(scene, DEM_Y_FLOOR);
    var floorX0 = demX(scene, floorStart);
    var floorX1 = demX(scene, DEM_X_RIGHT);
    var wallX = demX(scene, DEM_X_RIGHT);
    var wallTopY = demY(scene, wallTop);

    drawDemContactSurface(floorX0, floorY, floorX1, floorY, 0, -1, sx, p);
    drawDemContactSurface(wallX, floorY, wallX, wallTopY, -1, 0, sx, p);

    ctx.globalAlpha = W < 560 ? 0.84 : 0.96;
    for (var particleIndex = 0; particleIndex < particles.length; particleIndex++) {
      drawDemParticle(scene, particles[particleIndex], frame[particleIndex], p, particles[particleIndex].fixed ? 0.70 : 1);
    }
    ctx.restore();
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
    // Centerpiece: the specimen+plot cluster is sized from the canvas HEIGHT
    // (see biaxialMetrics) and the canvas is sized to hug that cluster, so the
    // figure fills the canvas. If the canvas is narrower than the natural
    // figure width (tight column) we scale the whole figure down to fit.
    var wide = isSideBySide();
    var m = biaxialMetrics(H);
    var sc = wide ? Math.min(1, W / m.figureW) : 1;
    var H0 = m.H0 * sc;
    var W0 = m.W0 * sc;             // ~2:1 height-to-width prismatic biaxial sample
    var cx = wide ? m.cx * sc : W * 0.5;
    var plotX = m.plotX * sc;
    var plotW = m.plotW * sc;
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


    // Axial stress arrow (σ1), grows with load — applied through the piston
    // cap at the top (the pedestal base reaction is implied, not drawn).
    var aLen = lerp(16, 38, t);
    arrow(cx, nutTopY - 10 - aLen, cx, nutTopY - 10, 7, p.axial, 2);

    // Lateral confining stress arrows (σ3), constant — anchored to the ACTUAL
    // deformed boundary nodes so they always sit just outside the bulged and
    // sheared edge (never inside the specimen at full deformation).
    var fr = [0.25, 0.5, 0.75];
    var s3X = cx + curW / 2 + 17, s3Y = baseY - curH * 0.5; // shaft midpoint of the middle σ3 arrow
    for (var fi = 0; fi < 3; fi++) {
      var rr = Math.round(fr[fi] * rows);
      var ln = nodes[rr][0];      // left boundary node
      var rn = nodes[rr][cols];   // right boundary node
      arrow(ln.x - 28, ln.y, ln.x - 6, ln.y, 6, p.confine, 1.5);
      arrow(rn.x + 28, rn.y, rn.x + 6, rn.y, 6, p.confine, 1.5);
      if (fi === 1) { s3X = rn.x + 17; s3Y = rn.y; }
    }

    // Labels — σ1 centred to the LEFT of the vertical (blue) piston arrow,
    // σ3 centred ABOVE the middle horizontal (green) confining arrow.
    ctx.fillStyle = p.label;
    ctx.font = '500 16px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('σ\u2081', cx - 10, nutTopY - 10 - aLen / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('σ\u2083', s3X, s3Y - 8);
    ctx.textBaseline = 'alphabetic';

    ctx.restore();

    // Stress–strain inset (q–εa with εv overlay). On wide canvases it sits to
    // the RIGHT of the specimen as part of the height-driven cluster; plotX is
    // its left edge and plotW its width (both from biaxialMetrics, scaled to
    // fit). Its bottom axis aligns with the specimen base (pedBottomY) so the
    // two read as one coherent figure.
    drawStressStrainInset(p, epsPct, epsMaxPct, narrow, wide, plotX, pedBottomY, plotW);
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

  function drawStressStrainInset(p, epsPct, epsMaxPct, narrow, wide, plotX, baseAlignY, plotW) {
    var bx, by, bw, bh;
    if (wide) {
      // Desktop: the plot is part of the height-driven specimen+plot cluster.
      // Its width (plotW) and left edge (plotX) come from biaxialMetrics, and
      // its bottom axis is aligned with the specimen base (baseAlignY) so the
      // two read as one coherent figure. Height keeps the fixed 0.8 (y/x) ratio.
      bw = Math.round(plotW);
      bh = Math.round(bw * 0.8); // fixed aspect ratio: y-axis = 0.8 × x-axis
      bx = Math.round(plotX);
      by = Math.round(baseAlignY - bh);
    } else {
      // Narrow / mobile: tuck a compact plot into the bottom-left corner.
      var pad = Math.max(14, Math.round(W * 0.045));
      bw = Math.round(Math.min(190, Math.max(110, W * 0.42)));
      bh = Math.round(bw * 0.8); // fixed aspect ratio: y-axis = 0.8 × x-axis
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
      ctx.fillStyle = p.axial;
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
    ctx.font = '500 14px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('q', bx - 2, by - 7);
    ctx.textAlign = 'center';
    ctx.fillText('\u03b5\u2090', bx + bw / 2, by + bh + 17);
    // secondary axis label (volumetric strain εv)
    ctx.fillStyle = p.vol;
    ctx.textAlign = 'right';
    ctx.fillText('\u03b5\u1d65', bx + bw + 2, by - 7);
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
    if (!isSideBySide()) return;
    if (running) render();
    else start();
  }

  function getMode() {
    return mode;
  }

  // ── Events ──
  function onScroll() {
    updateProgress();
    if (mode === 'off' || !isSideBySide()) return;
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
