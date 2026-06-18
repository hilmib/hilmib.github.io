import React, { useEffect, useRef, useState } from "react";
import { Info, Play, RefreshCw, Ruler, Swords, Sliders } from "lucide-react";

interface TriaxialSimulationProps {
  scrollProgress: number; // 0 to 1
}

interface Particle {
  originalX: number;
  originalY: number;
  x: number;
  y: number;
  radius: number;
  color: string;
  shearStrain: number;
  side: "left" | "right"; // which side of shear plane it falls on
}

export default function TriaxialSimulation({ scrollProgress }: TriaxialSimulationProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [confiningPressure, setConfiningPressure] = useState(40); // kPa (sigma_3)
  const [frictionAngle, setFrictionAngle] = useState(30); // degrees (phi)
  const [isDense, setIsDense] = useState(true); // dense sand has stress-softening, loose sand has strain-hardening!

  // Keep references for particles
  const particlesRef = useRef<Particle[]>([]);

  // Initialize particles in a cylinder-like grid
  const initParticles = () => {
    const list: Particle[] = [];
    const colors = ["#94a3b8", "#cbd5e1", "#64748b", "#cbd5e1", "#334155"];

    const cylinderWidth = 100;
    const cylinderHeight = 180;
    const centerX = 110;
    const topY = 110;

    const rows = 14;
    const cols = 8;
    const xStep = cylinderWidth / (cols - 1);
    const yStep = cylinderHeight / (rows - 1);

    // Dynamic shear failure plane definition
    // shear band angle relative to horizontal = 45 + phi/2
    const thetaRad = ((45 + frictionAngle / 2) * Math.PI) / 180;
    const pX = centerX;
    const pY = topY + cylinderHeight / 2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Form a cylinder with curved edges or slight noise
        const relativeX = -cylinderWidth / 2 + c * xStep + (Math.random() - 0.5) * 1.5;
        const relativeY = r * yStep + (Math.random() - 0.5) * 1.5;

        const x = centerX + relativeX;
        const y = topY + relativeY;

        // Skip corners to make cylindrical round specimen
        const edgeOffset = Math.sin((relativeY / cylinderHeight) * Math.PI);
        const radiusFactor = 0.85 + 0.15 * edgeOffset;
        if (Math.abs(relativeX) > (cylinderWidth / 2) * radiusFactor + 2) {
          continue;
        }

        // Determine which side of the potential shear plane this particle lies on
        // Equation of shear line passing through (pX, pY) with tilt theta:
        // y - pY = -tan(theta) * (x - pX) ==> y + tan(theta)*(x-pX) - pY = 0
        const m = -Math.tan(thetaRad);
        const sideValue = y - pY - m * (x - pX);
        const side = sideValue > 0 ? "right" : "left";

        list.push({
          originalX: x,
          originalY: y,
          x: x,
          y: y,
          radius: 4.5 + Math.random() * 2,
          color: colors[Math.floor(Math.random() * colors.length)],
          shearStrain: 0,
          side: side,
        });
      }
    }
    particlesRef.current = list;
  };

  // Re-initialize particles when parameters change
  useEffect(() => {
    initParticles();
  }, [frictionAngle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // We can define strain as a function of our scroll progress
    // Let's scale scrollProgress from 0 to 1 as axial strain from 0% to 18%
    const strain = scrollProgress * 0.18; // 0 to 18% axial strain

    // Mathematical formula for deviatoric stress q = sigma_1 - sigma_3 based on soil mechanics
    // Peak stress depends on confining pressure (sigma_3) and friction angle (phi)
    // Cohesion is taken as a minor value c = 5 kPa
    const cohesion = 5;
    const phiRad = (frictionAngle * Math.PI) / 180;
    const sinPhi = Math.sin(phiRad);
    
    // Mohr-Coulomb peak shear strength
    const maxStressDifference = ((2 * cohesion * Math.cos(phiRad) + 2 * confiningPressure * sinPhi) / (1 - sinPhi)) * 1.5;

    // Deviatoric Stress-Strain behavior Curve formulation:
    // Dense sand has a high peak then softens to residual
    // Loose sand rises gradually to a stable state (strain-hardening/critical state)
    const getDeviatorStress = (e: number) => {
      if (e <= 0) return 0;
      if (isDense) {
        // Softening peak response curve
        const peakStrain = 0.07; // 7% strain
        const residualFactor = 0.65; // drops to 65% of peak
        
        if (e < peakStrain) {
          // Elastic loading rise
          const factor = Math.sin((e / peakStrain) * (Math.PI / 2));
          return maxStressDifference * factor;
        } else {
          // Strains soft post peak
          const softp = Math.min(1.0, (e - peakStrain) / 0.11); // softening span
          const drop = (1.0 - residualFactor) * Math.sin(softp * (Math.PI / 2));
          return maxStressDifference * (1.0 - drop);
        }
      } else {
        // Loose hardening critical-state curve
        const hardenLimit = 0.15;
        if (e < hardenLimit) {
          const factor = Math.sin((e / hardenLimit) * (Math.PI / 2));
          return maxStressDifference * 0.8 * factor;
        } else {
          return maxStressDifference * 0.8;
        }
      }
    };

    // Current q (deviator stress)
    const activeQ = getDeviatorStress(strain);
    // Corresponding sigma_1 = sigma_3 + q
    const activeSigma1 = confiningPressure + activeQ;

    // Shear failure activation threshold: around 7% strain
    const isFailed = isDense ? strain > 0.07 : strain > 0.12;
    const failureIntensity = isFailed 
      ? isDense
        ? Math.min(1.0, (strain - 0.07) / 0.11)
        : Math.min(1.0, (strain - 0.12) / 0.06) 
      : 0;

    // Redraw loop
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // ─── PART 1: CHOOSE GRID SCALE AND DIMENSIONS ───
    const specimenCenterX = 110;
    const specimenBaseY = 290;
    const originalHeight = 180;
    const originalWidth = 100;
    
    // Calculate current dimensions conserving volume
    // Specimen height squashes down: H = H_0 * (1 - strain)
    const currentHeight = originalHeight * (1 - strain);
    // Average width increases (bulges) to conserve mass: dV/V = 0 (or close)
    // Standard soil bulging ratio (Poisson's expansion)
    const currentAverageWidth = originalWidth * (1 + strain * 0.55);
    const topY = specimenBaseY - currentHeight;

    // Calculate bulging amplitude
    const bulgeAmp = strain * 18;

    // ─── PART 2: ANIMATE PARTICLES (INTER-GRAIN SHEARING) ───
    const thetaRad = ((45 + frictionAngle / 2) * Math.PI) / 180;
    const shearLineMiddleY = specimenBaseY - originalHeight / 2;

    const particles = particlesRef.current;
    particles.forEach((p) => {
      // 1. Calculate base squash coordinates
      const pctY = (p.originalY - 110) / originalHeight; // relative vertical coordinate [0, 1]
      const relativeY = pctY * currentHeight;
      p.y = topY + relativeY;

      // 2. Lateral bulge mapping (curving outward following sinusoidal bulge shape)
      const pctX = (p.originalX - specimenCenterX) / (originalWidth / 2); // ratio [-1, 1]
      const bulgeProfile = Math.sin(pctY * Math.PI); // shape is a sine wave spanning top to bottom
      const offsetBulge = pctX * bulgeAmp * bulgeProfile;
      p.x = p.originalX + offsetBulge;

      // 3. Coordinate shear sliding displacement post-peak along failure band angle
      if (isFailed && failureIntensity > 0) {
        // Equation of sliding: grains slide relative to each other along the diagonal plane
        // The plane cuts from bottom-left to top-right
        // Let's shift "left" grains up-left and "right" grains down-right along the slide angle
        const slideMagnitude = failureIntensity * 12; // slide offset in pixels
        const dx_slide = Math.cos(thetaRad) * slideMagnitude;
        const dy_slide = -Math.sin(thetaRad) * slideMagnitude;

        if (p.side === "left") {
          p.x -= dx_slide * 0.5;
          p.y += dy_slide * 0.5;
        } else {
          p.x += dx_slide * 0.5;
          p.y -= dy_slide * 0.5;
        }

        // Calculate proximity to the shear line to map shear localized strain contours (DIC heatmap)
        // Distance to line: Ax + By + C = 0
        const m = -Math.tan(thetaRad); // slope
        const b = (specimenBaseY - currentHeight/2) - m * specimenCenterX; // intercept
        // line eq: mx - y + b = 0
        const distToShearLine = Math.abs(m * p.x - p.y + b) / Math.sqrt(m * m + 1);
        p.shearStrain = Math.max(0, 1 - distToShearLine / 24); // localized within 24px of shear plane
      } else {
        p.shearStrain = 0;
      }
    });

    // Draw Triaxial Cylinder Specimen Latex Membrane (Bulging Contour)
    ctx.strokeStyle = "rgba(148, 163, 184, 0.9)";
    ctx.lineWidth = 3.5;
    ctx.fillStyle = "rgba(51, 65, 85, 0.05)";
    
    // Draw fluid inside cell overlay
    ctx.fillStyle = "rgba(30, 41, 59, 0.35)"; // dark gray specimen chamber
    ctx.fillRect(50, 60, 120, 260);

    // Lateral confining arrows to show Sigma_3
    ctx.strokeStyle = "#38bdf8"; // cyan light arrows
    ctx.lineWidth = 1.5;
    const drawConArrow = (arrowX: number, arrowY: number, direction: 1 | -1) => {
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX + 16 * direction, arrowY);
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX + 5 * direction, arrowY - 4);
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX + 5 * direction, arrowY + 4);
      ctx.stroke();
    };

    // Draw confinement pressure indicator arrows
    for (let arrowY = 120; arrowY <= 260; arrowY += 45) {
      drawConArrow(40, arrowY, 1);   // pointing right into membrane
      drawConArrow(180, arrowY, -1);  // pointing left into membrane
    }

    // Specimen boundary shape
    ctx.beginPath();
    // Start at top-left
    ctx.moveTo(specimenCenterX - currentAverageWidth/2, topY);
    // Bezier curve to bottom-left to show bulging
    ctx.quadraticCurveTo(
      specimenCenterX - currentAverageWidth/2 - bulgeAmp,
      specimenBaseY - currentHeight/2,
      specimenCenterX - currentAverageWidth/2,
      specimenBaseY
    );
    // Line to bottom-right
    ctx.lineTo(specimenCenterX + currentAverageWidth/2, specimenBaseY);
    // Bezier curve to top-right to show bulging
    ctx.quadraticCurveTo(
      specimenCenterX + currentAverageWidth/2 + bulgeAmp,
      specimenBaseY - currentHeight/2,
      specimenCenterX + currentAverageWidth/2,
      topY
    );
    ctx.closePath();
    ctx.fillStyle = "rgba(100, 116, 139, 0.1)";
    ctx.fill();
    ctx.stroke();

    // Draw Grains (Particles) inside cylinder
    particles.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);

      // Color coding: If sheared, map to localized shear strain color heat contours
      if (isFailed && p.shearStrain > 0.1) {
        // Red glowing localized shear strain (DIC heat coloring)
        const redRatio = Math.floor(p.shearStrain * 180 + 75);
        const greenRatio = Math.floor((1 - p.shearStrain) * 90);
        ctx.fillStyle = `rgb(${redRatio}, ${greenRatio}, 20)`; // hot bright failure plane color!
      } else {
        ctx.fillStyle = p.color;
      }
      ctx.fill();

      // Simple black grain outline
      ctx.strokeStyle = "rgba(15, 23, 42, 0.25)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    });

    // Draw Steel Cap platens (Top and Bottom loading caps)
    ctx.fillStyle = "#334155"; // solid dark slate
    ctx.fillRect(specimenCenterX - currentAverageWidth/2 - 5, topY - 14, currentAverageWidth + 10, 14);
    ctx.fillRect(specimenCenterX - currentAverageWidth/2 - 5, specimenBaseY, currentAverageWidth + 10, 14);

    // CAP labels
    ctx.fillStyle = "#f1f5f9";
    ctx.font = "bold 9px 'JetBrains Mono', monospace";
    ctx.fillText("APPLIED LOAD σ1", specimenCenterX - 38, topY - 4);
    ctx.fillText("BASE PLATTEN", specimenCenterX - 32, specimenBaseY + 10);

    // Draw failure line plane visually if failing
    if (isFailed) {
      ctx.strokeStyle = `rgba(239, 68, 68, ${failureIntensity * 0.8})`; // neon red failure line
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      
      // Calculate coordinates tracing failure band angle theta
      const diagonalL = 150;
      const xOffset = Math.cos(thetaRad) * diagonalL;
      const yOffset = Math.sin(thetaRad) * diagonalL;
      
      ctx.moveTo(specimenCenterX - xOffset * 0.7, specimenBaseY - currentHeight/2 + yOffset * 0.7);
      ctx.lineTo(specimenCenterX + xOffset * 0.7, specimenBaseY - currentHeight/2 - yOffset * 0.7);
      ctx.stroke();
      ctx.setLineDash([]); // clear

      // Draw sliding shear displacement micro vector arrows
      if (failureIntensity > 0.2) {
        ctx.strokeStyle = "#ef4444";
        ctx.fillStyle = "#ef4444";
        ctx.lineWidth = 1.8;
        
        // Shear vector arrows
        const drawArrow = (fromX: number, fromY: number, toX: number, toY: number) => {
          ctx.beginPath();
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(toX, toY);
          const angle = Math.atan2(toY - fromY, toX - fromX);
          ctx.lineTo(toX - 5 * Math.cos(angle - Math.PI / 6), toY - 5 * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(toX, toY);
          ctx.lineTo(toX - 5 * Math.cos(angle + Math.PI / 6), toY - 5 * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        };

        drawArrow(specimenCenterX + 15, specimenBaseY - currentHeight/2 - 15, specimenCenterX + 35, specimenBaseY - currentHeight/2 - 30);
        drawArrow(specimenCenterX - 15, specimenBaseY - currentHeight/2 + 15, specimenCenterX - 35, specimenBaseY - currentHeight/2 + 30);
      }
    }

    // ─── PART 3: TRACE LIVE GRAPH 1 (DEVIATOR STRESS Q VS AXIAL STRAIN) ───
    const graph1Left = 250;
    const graph1Top = 30;
    const graph1W = 200;
    const graph1H = 130;

    // Draw graph background axis border
    ctx.fillStyle = "#0f172a"; // slate box
    ctx.fillRect(graph1Left, graph1Top, graph1W, graph1H);
    ctx.strokeStyle = "rgba(71, 85, 105, 0.5)";
    ctx.strokeRect(graph1Left, graph1Top, graph1W, graph1H);

    // Graph labels
    ctx.fillStyle = "#94a3b8";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillText("DEVIATOR STRESS q (kPa)", graph1Left + 10, graph1Top + 14);
    ctx.fillText("AXIAL STRAIN ε_a (%)", graph1Left + 10, graph1Top + graph1H - 8);

    // Axis gridlines
    ctx.strokeStyle = "rgba(30, 41, 59, 0.6)";
    ctx.lineWidth = 0.5;
    for (let s = 1; s <= 4; s++) {
      const gX = graph1Left + (s * graph1W) / 5;
      const gY = graph1Top + (s * graph1H) / 5;
      // Vert line
      ctx.beginPath(); ctx.moveTo(gX, graph1Top); ctx.lineTo(gX, graph1Top + graph1H); ctx.stroke();
      // Horiz line
      ctx.beginPath(); ctx.moveTo(graph1Left, gY); ctx.lineTo(graph1Left + graph1W, gY); ctx.stroke();
    }

    // Plot full theoretical curve line up to strain limit (18%)
    ctx.strokeStyle = "rgba(100, 116, 139, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x_px = 0; x_px < graph1W; x_px++) {
      const e_val = (x_px / graph1W) * 0.18;
      const q_val = getDeviatorStress(e_val);
      // Map limits
      const plotterY = graph1Top + graph1H - (q_val / maxStressDifference) * (graph1H - 30) - 10;
      if (x_px === 0) ctx.moveTo(graph1Left + x_px, plotterY);
      else ctx.lineTo(graph1Left + x_px, plotterY);
    }
    ctx.stroke();

    // Plot dynamic active colored cursor tracing current strain position
    ctx.strokeStyle = isDense ? "#f59e0b" : "#10b981"; // Amber or Emerald
    ctx.lineWidth = 3;
    ctx.beginPath();
    const cursorLimitX = (strain / 0.18) * graph1W;
    for (let x_px = 0; x_px <= cursorLimitX; x_px++) {
      const e_val = (x_px / graph1W) * 0.18;
      const q_val = getDeviatorStress(e_val);
      const plotterY = graph1Top + graph1H - (q_val / maxStressDifference) * (graph1H - 30) - 10;
      if (x_px === 0) ctx.moveTo(graph1Left + x_px, plotterY);
      else ctx.lineTo(graph1Left + x_px, plotterY);
    }
    ctx.stroke();

    // Draw glowing flash cursor on the curve tip
    const currentQPlotY = graph1Top + graph1H - (activeQ / maxStressDifference) * (graph1H - 30) - 10;
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(graph1Left + cursorLimitX, currentQPlotY, 4, 0, Math.PI * 2);
    ctx.fill();

    // ─── PART 4: TRACE LIVE GRAPH 2 (MOHR'S CIRCLE OF STRES) ───
    const graph2Left = 250;
    const graph2Top = 205;
    const graph2W = 200;
    const graph2H = 150;

    // Draw graph background axis border
    ctx.fillStyle = "#0f172a"; // slate box
    ctx.fillRect(graph2Left, graph2Top, graph2W, graph2H);
    ctx.strokeStyle = "rgba(71, 85, 105, 0.5)";
    ctx.strokeRect(graph2Left, graph2Top, graph2W, graph2H);

    // Labels
    ctx.fillStyle = "#94a3b8";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillText("SHEAR STRESS τ (kPa)", graph2Left + 10, graph2Top + 14);
    ctx.fillText("NORMAL STRESS σ (kPa)", graph2Left + 10, graph2Top + graph2H - 8);

    // Max limits for Mohr space scaling
    const maxSigmaLimit = confiningPressure + maxStressDifference * 1.6;

    // Draw Coulomb failure envelope lines: tau = c + sigma * tan(phi)
    ctx.strokeStyle = "rgba(239, 68, 68, 0.75)"; // bright red failure line
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const startY_Coulomb = graph2Top + graph2H - (cohesion / maxSigmaLimit) * (graph2H - 30) - 15;
    ctx.moveTo(graph2Left, startY_Coulomb);
    // End value
    const endTau_Coulomb = cohesion + maxSigmaLimit * Math.tan(phiRad);
    const endY_Coulomb = graph2Top + graph2H - (endTau_Coulomb / maxSigmaLimit) * (graph2H - 30) - 15;
    ctx.lineTo(graph2Left + graph2W, endY_Coulomb);
    ctx.stroke();

    // Tag Failure Envelope line
    ctx.fillStyle = "#f87171";
    ctx.fillText("FAILURE ENVELOPE (τ = c + σ·tanφ)", graph2Left + 25, endY_Coulomb + 15);

    // Draw active Mohr's stress circle: center is ( (sigma_1 + sigma_3)/2 , 0 ), radius is (sigma_1 - sigma_3)/2 = q / 2
    const circleCenterX_val = (activeSigma1 + confiningPressure) / 2;
    const circleRadius_val = (activeSigma1 - confiningPressure) / 2; // q/2

    // Map circle coordinates to Graph pixel scale
    const mapStressX = (val: number) => graph2Left + (val / maxSigmaLimit) * (graph2W - 20) + 10;
    // Mohr circle center in px (Y lies on zero stress axis of shear tau=0, which is bottom horizontal of axis)
    const axisZeroY = graph2Top + graph2H - 18;
    const circleCenterPx = mapStressX(circleCenterX_val);
    const circleRadiusPx = (circleRadius_val / maxSigmaLimit) * (graph2W - 20);

    // Draw circle path
    ctx.strokeStyle = isFailed ? "rgba(239, 68, 68, 0.85)" : "#38bdf8"; // Red failed or Blue safe Mohr circle
    ctx.lineWidth = 2;
    ctx.fillStyle = "rgba(56, 189, 248, 0.08)";
    ctx.beginPath();
    ctx.arc(circleCenterPx, axisZeroY, circleRadiusPx, 0, Math.PI, true); // draw semicircle for positive shear space
    ctx.stroke();
    ctx.fill();

    // Plot vertices labeled σ3 and σ1 (dynamic stress state anchors)
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(mapStressX(confiningPressure), axisZeroY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText("σ3", mapStressX(confiningPressure) - 6, axisZeroY - 6);

    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(mapStressX(activeSigma1), axisZeroY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText("σ1", mapStressX(activeSigma1) - 6, axisZeroY - 6);

    // Draw Stress HUD at bottom of graphs (beautiful telemetry stats)
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillText(`AXIAL STRAIN  (εa) : ${(strain * 100).toFixed(1)}%`, 14, 30);
    ctx.fillText(`DEVIATOR S    (q)  : ${activeQ.toFixed(0)} kPa`, 14, 43);
    ctx.fillText(`CONFINEMENT   (σ3) : ${confiningPressure.toFixed(0)} kPa`, 14, 56);
    ctx.fillStyle = isFailed ? "#ef4444" : "#10b981";
    ctx.fillText(`FAIL RATIO (q/q_max): ${Math.min(1.0, activeQ / maxStressDifference).toFixed(2)} ${isFailed ? "⚠️ FAILURE" : "✔ STABLE"}`, 14, 69);

  }, [scrollProgress, confiningPressure, frictionAngle, isPlaying, isDense]);

  return (
    <div className="flex flex-col h-full justify-between">
      {/* Simulation Screen Container */}
      <div className="relative flex-1 bg-slate-950 dark:bg-slate-950/60 rounded-xl overflow-hidden border border-slate-200/50 dark:border-slate-800 flex items-center justify-center min-h-[360px]">
        {/* Absolute Background branding grid */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:30px_30px] opacity-10 pointer-events-none"></div>

        <canvas
          ref={canvasRef}
          width={480}
          height={400}
          className="w-full max-w-[480px] h-full object-contain relative z-10"
        />

        {/* Hover info overlay */}
        <div className="absolute top-2.5 right-2.5 z-20">
          <span className="bg-slate-900/90 border border-slate-700 text-slate-300 text-[10px] px-2.5 py-1 font-mono rounded flex items-center gap-1">
            <Info className="w-3 h-3 text-slate-400" />
            LIVE SPECI: 38mm x 76mm SILICA CLAY
          </span>
        </div>
      </div>

      {/* Manual Specimen Chamber variables sliders (so the geotechnical engineer can alter variables dynamically!) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 p-4 rounded-xl mt-3 flex flex-col gap-3 shadow-sm text-sm">
        <div className="flex flex-wrap gap-4 items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
          <div className="flex gap-2 items-center">
            <button
              onClick={() => setIsDense(!isDense)}
              className={`cursor-pointer px-3 py-1 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all ${
                isDense
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-400"
                  : "bg-blue-100 text-blue-800 dark:bg-blue-950/30 dark:text-blue-400"
              }`}
            >
              <Swords className="w-3.5 h-3.5" />
              Soil State: {isDense ? "Dense Sand (Softens)" : "Loose Sand (Hardens)"}
            </button>
            <button
              onClick={() => initParticles()}
              className="cursor-pointer p-1.5 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 active:scale-95 transition-all"
              title="Reset Grain Placement"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex items-center gap-1.5 text-slate-500 font-mono text-[11px]">
            <Ruler className="w-3.5 h-3.5 text-indigo-500" />
            Shear Angle (θ): <span className="text-indigo-600 dark:text-indigo-400 font-bold">{45 + frictionAngle / 2}°</span>
          </div>
        </div>

        {/* Dynamic variable sliders */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-400 flex justify-between">
              <span>Cell Confinement (σ3) :</span>
              <span className="font-mono text-primary font-semibold">{confiningPressure} kPa</span>
            </label>
            <input
              type="range"
              min="20"
              max="100"
              step="5"
              value={confiningPressure}
              onChange={(e) => setConfiningPressure(Number(e.target.value))}
              className="w-full accent-primary h-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-400 flex justify-between">
              <span>Fr. Angle (φ) :</span>
              <span className="font-mono text-primary font-semibold">{frictionAngle}°</span>
            </label>
            <input
              type="range"
              min="15"
              max="40"
              step="1"
              value={frictionAngle}
              onChange={(e) => setFrictionAngle(Number(e.target.value))}
              className="w-full accent-primary h-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
