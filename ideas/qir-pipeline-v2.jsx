import { useState, useEffect, useRef, useCallback } from "react";

// ─── Config ─────────────────────────────────────────────────────────
const STAGES = [
  { id: "queue", label: "Queue", desc: "Waiting", color: [168, 155, 140], x0: 0, x1: 0.12 },
  { id: "ingest", label: "Ingest", desc: "RSS → Episodes", color: [196, 145, 62], x0: 0.12, x1: 0.35 },
  { id: "transcribe", label: "Transcribe", desc: "Audio → Text", color: [75, 125, 141], x0: 0.35, x1: 0.62 },
  { id: "summarize", label: "Summarize", desc: "Text → Insights", color: [107, 143, 113], x0: 0.62, x1: 0.82 },
  { id: "done", label: "Done", desc: "Complete", color: [107, 143, 113], x0: 0.82, x1: 1.0 },
];

const MODES = {
  steady: { label: "Steady", transcribe: 1, summarize: 5 },
  catchup: { label: "Catch-up", transcribe: 3, summarize: 10 },
};

const SAMPLE_EPISODES = [
  "Democracy Now! · Jun 26", "Beneath The Surface · Jun 29", "Beneath The Surface · Jun 22",
  "Conversations COTW · Jun 4", "Beneath The Surface · Jun 8", "Chris Hedges · May 17",
  "Malcolm X Centennial · May 19", "Background Briefing · May 13", "Beneath The Surface · May 25",
  "Beneath The Surface · May 18", "Beneath The Surface · May 11", "Sojourner Truth · Apr 29",
  "Car Show · Apr 12", "Beneath The Surface · Apr 20", "Chris Hedges · Apr 5",
  "Beneath The Surface · Apr 13", "Chris Hedges · Apr 12", "Ralph Nader Hour · Apr 6",
  "Background Briefing · Apr 8", "Democracy Now! · May 5",
];

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function rgbStr(c, a = 1) {
  return a < 1 ? `rgba(${c[0]},${c[1]},${c[2]},${a})` : `rgb(${c[0]},${c[1]},${c[2]})`;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ─── Particle Creation ──────────────────────────────────────────────
let nextId = 0;
function createParticle(W, H, stageIdx = 0) {
  const stage = STAGES[stageIdx];
  const xMin = stage.x0 * W + 15;
  const xMax = stage.x1 * W - 15;
  return {
    id: nextId++,
    label: SAMPLE_EPISODES[nextId % SAMPLE_EPISODES.length],
    x: xMin + Math.random() * (xMax - xMin),
    y: 55 + Math.random() * (H - 85),
    targetX: null,
    targetY: null,
    vx: 0,
    vy: 0,
    radius: 5.5 + Math.random() * 2,
    stageIdx,
    stageProgress: 0, // 0→1 within current stage
    colorBlend: 0, // for smooth color transition between stages
    colorFrom: stage.color,
    colorTo: stage.color,
    currentColor: [...stage.color],
    phase: Math.random() * Math.PI * 2,
    opacity: 1,
    fadeState: "visible", // visible | fading
    fadeTimer: 0,
    doneLingerTime: 3 + Math.random() * 4, // seconds to linger in done zone
  };
}

// ─── Canvas Visualizer ──────────────────────────────────────────────
function PipelineVisualizer({ mode = "steady", isRunning = false }) {
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const animRef = useRef(null);
  const hoveredRef = useRef(null);
  const mouseRef = useRef({ x: -999, y: -999 });
  const timeRef = useRef(0);
  const lastFrameRef = useRef(0);
  const [hovered, setHovered] = useState(null);
  const wasRunningRef = useRef(false);
  const dimsRef = useRef({ W: 0, H: 0 });

  // Init particles spread across stages
  const initParticles = useCallback((W, H) => {
    const particles = [];
    nextId = 0;
    // Distribute: some in each stage to represent current state
    const distribution = [3, 4, 5, 6, 7]; // queue, ingest, transcribe, summarize, done
    distribution.forEach((count, stageIdx) => {
      for (let i = 0; i < count; i++) {
        const p = createParticle(W, H, stageIdx);
        if (stageIdx === 4) {
          p.opacity = 0.5 + Math.random() * 0.4;
          p.fadeState = "visible";
        }
        particles.push(p);
      }
    });
    particlesRef.current = particles;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    dimsRef.current = { W, H };

    if (particlesRef.current.length === 0) {
      initParticles(W, H);
    }

    lastFrameRef.current = performance.now();

    const frame = (now) => {
      const rawDt = Math.min((now - lastFrameRef.current) / 1000, 0.05);
      lastFrameRef.current = now;
      const dt = rawDt;
      timeRef.current += rawDt; // real time for visual effects
      const t = timeRef.current;

      ctx.clearRect(0, 0, W, H);

      const particles = particlesRef.current;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      // ── Draw stage zones ──
      STAGES.forEach((stage, i) => {
        const x0 = stage.x0 * W;
        const x1 = stage.x1 * W;
        const w = x1 - x0;

        // Subtle fill
        if (i > 0 && i < 4) {
          ctx.fillStyle = rgbStr(stage.color, 0.04);
          ctx.fillRect(x0, 0, w, H);
        }
        if (i === 4) {
          // Done zone — slightly different
          const grad = ctx.createLinearGradient(x0, 0, x1, 0);
          grad.addColorStop(0, rgbStr(stage.color, 0.03));
          grad.addColorStop(1, "transparent");
          ctx.fillStyle = grad;
          ctx.fillRect(x0, 0, w, H);
        }

        // Dividers
        if (i > 0 && i < 5) {
          ctx.beginPath();
          ctx.strokeStyle = "rgba(200,190,175,0.2)";
          ctx.setLineDash([3, 7]);
          ctx.moveTo(x0, 18);
          ctx.lineTo(x0, H - 12);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Labels
        if (i > 0) {
          ctx.fillStyle = i === 4 ? "#C4B99A" : "#9A8E80";
          ctx.font = "600 9.5px 'DM Sans', sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(stage.label.toUpperCase(), x0 + w / 2, 20);
          if (i < 4) {
            ctx.font = "400 8.5px 'DM Sans', sans-serif";
            ctx.fillStyle = "#C4B99A";
            ctx.fillText(stage.desc, x0 + w / 2, 33);
          }
        }
      });

      // ── Ambient flow current when running ──
      if (isRunning) {
        ctx.beginPath();
        ctx.strokeStyle = "rgba(75,125,141,0.04)";
        ctx.lineWidth = 50;
        ctx.moveTo(0, H * 0.5);
        for (let x = 0; x <= W; x += 5) {
          ctx.lineTo(x, H * 0.5 + Math.sin(x * 0.006 + t * 0.8) * 20 + Math.sin(x * 0.002 + t * 0.3) * 12);
        }
        ctx.stroke();
      }

      // ── Update particles ──
      let newHovered = null;

      // Move active particles through stages when running
      particles.forEach((p) => {
        const stage = STAGES[p.stageIdx];
        const stageX0 = stage.x0 * W + 15;
        const stageX1 = stage.x1 * W - 15;
        const stageW = stageX1 - stageX0;

        if (isRunning && p.fadeState === "visible") {
          if (p.stageIdx < 4) {
            // Speed varies by stage: transcribe is slowest
            const speeds = [0.8, 0.6, 0.15, 0.4]; // queue, ingest, transcribe, summarize (units/sec roughly)
            const speed = speeds[p.stageIdx] * (mode === "catchup" ? 1.6 : 1);
            const pxPerSec = speed * stageW;

            p.x += pxPerSec * dt * (0.5 + Math.sin(t * 0.7 + p.phase) * 0.1);

            // Gentle vertical drift
            p.y += Math.sin(t * 0.9 + p.phase) * 0.4;
            p.y += Math.cos(t * 0.6 + p.phase * 1.7) * 0.25;
            p.y = Math.max(50, Math.min(H - 25, p.y));

            // Stage transition
            if (p.x > stageX1) {
              const prevColor = [...STAGES[p.stageIdx].color];
              p.stageIdx++;
              p.colorFrom = prevColor;
              p.colorTo = [...STAGES[p.stageIdx].color];
              p.colorBlend = 0;

              if (p.stageIdx === 4) {
                // Entered done zone
                const doneStage = STAGES[4];
                p.x = doneStage.x0 * W + 20 + Math.random() * (doneStage.x1 - doneStage.x0) * W * 0.6;
                p.fadeTimer = 0;
              } else {
                p.x = STAGES[p.stageIdx].x0 * W + 18;
              }
            }
          } else {
            // Done zone: drift slowly right and linger
            p.x += 2 * rawDt; // very slow real-time drift
            p.y += Math.sin(t * 0.3 + p.phase) * 0.15;
            p.fadeTimer += rawDt; // real time

            if (p.fadeTimer > p.doneLingerTime) {
              p.fadeState = "fading";
            }
          }
        } else if (p.fadeState === "fading") {
          p.opacity -= rawDt * 0.4; // fade over ~2.5s real time
          p.y += Math.sin(t * 0.3 + p.phase) * 0.1;
          if (p.opacity <= 0) {
            p.opacity = 0;
          }
        } else if (!isRunning) {
          // Static idle — very subtle breathing only
          // No positional movement, just a gentle radius pulse handled in draw
        }

        // Smooth color blending
        if (p.colorBlend < 1) {
          p.colorBlend = Math.min(1, p.colorBlend + rawDt * 1.8); // ~0.55s blend
          const easedBlend = easeOutCubic(p.colorBlend);
          p.currentColor = lerpColor(p.colorFrom, p.colorTo, easedBlend);
        }

        // ── Draw particle ──
        const dx = mx - p.x;
        const dy = my - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const isHov = dist < p.radius + 14 && p.opacity > 0.2;
        if (isHov) newHovered = p;

        const breathe = isRunning ? Math.sin(t * 2.2 + p.phase) * 1.2 : Math.sin(t * 0.8 + p.phase) * 0.4;
        const r = (isHov ? p.radius + 2.5 : p.radius) + breathe;
        const alpha = p.opacity;

        if (alpha <= 0.01) return;

        // Outer glow
        const glowR = isRunning ? r + 14 + Math.sin(t * 1.5 + p.phase) * 4 : r + 8;
        const grd = ctx.createRadialGradient(p.x, p.y, r * 0.3, p.x, p.y, glowR);
        grd.addColorStop(0, rgbStr(p.currentColor, 0.25 * alpha));
        grd.addColorStop(0.6, rgbStr(p.currentColor, 0.08 * alpha));
        grd.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        // Core orb
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.fillStyle = rgbStr(p.currentColor, alpha * 0.9);
        ctx.fill();

        // Inner highlight
        const hlGrd = ctx.createRadialGradient(p.x - r * 0.25, p.y - r * 0.25, 0, p.x, p.y, r);
        hlGrd.addColorStop(0, `rgba(255,255,255,${0.3 * alpha})`);
        hlGrd.addColorStop(0.7, `rgba(255,255,255,${0.05 * alpha})`);
        hlGrd.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.fillStyle = hlGrd;
        ctx.fill();
      });

      // ── Connection lines (same stage, nearby) ──
      const visibleParticles = particles.filter(p => p.opacity > 0.15);
      for (let i = 0; i < visibleParticles.length; i++) {
        const a = visibleParticles[i];
        for (let j = i + 1; j < visibleParticles.length; j++) {
          const b = visibleParticles[j];
          if (a.stageIdx !== b.stageIdx) continue;
          const ddx = a.x - b.x;
          const ddy = a.y - b.y;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d < 70) {
            const lineAlpha = (1 - d / 70) * 0.12 * Math.min(a.opacity, b.opacity);
            ctx.beginPath();
            ctx.strokeStyle = rgbStr(a.currentColor, lineAlpha);
            ctx.lineWidth = 0.6;
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Remove fully faded particles and spawn new ones in queue when running
      particlesRef.current = particles.filter(p => p.opacity > 0.01);

      if (isRunning) {
        const queueCount = particles.filter(p => p.stageIdx === 0).length;
        if (queueCount < 4 && Math.random() < rawDt * 0.5) {
          particlesRef.current.push(createParticle(W, H, 0));
        }
      }

      // Hover state
      if (newHovered !== hoveredRef.current) {
        hoveredRef.current = newHovered;
        setHovered(newHovered ? { label: newHovered.label, stage: STAGES[newHovered.stageIdx].label, x: newHovered.x, y: newHovered.y, color: [...newHovered.currentColor] } : null);
      }

      animRef.current = requestAnimationFrame(frame);
    };

    animRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animRef.current);
  }, [mode, isRunning, initParticles]);

  // Reset particles when toggling run
  useEffect(() => {
    if (isRunning && !wasRunningRef.current) {
      const { W, H } = dimsRef.current;
      if (W > 0) initParticles(W, H);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, initParticles]);

  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { mouseRef.current = { x: -999, y: -999 }; setHovered(null); }}
        style={{
          width: "100%",
          height: 240,
          borderRadius: 10,
          cursor: hovered ? "pointer" : "default",
        }}
      />
      {/* Tooltip */}
      {hovered && (
        <div style={{
          position: "absolute",
          left: Math.max(80, Math.min(hovered.x, 700)),
          top: Math.max(10, hovered.y - 56),
          background: "#2D2519",
          color: "#F5F0E8",
          padding: "9px 16px",
          borderRadius: 9,
          fontSize: 12,
          fontFamily: "'DM Sans', sans-serif",
          pointerEvents: "none",
          whiteSpace: "nowrap",
          boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
          transform: "translateX(-50%)",
          zIndex: 10,
          borderBottom: `2px solid ${rgbStr(hovered.color)}`,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{hovered.label}</div>
          <div style={{ color: rgbStr(hovered.color), fontSize: 11 }}>{hovered.stage}</div>
        </div>
      )}
      {/* Idle overlay hint */}
      {!isRunning && (
        <div style={{
          position: "absolute",
          bottom: 12,
          right: 16,
          fontSize: 11,
          color: "#C4B99A",
          fontFamily: "'DM Sans', sans-serif",
          pointerEvents: "none",
        }}>
          Pipeline idle
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────
export default function PipelineDashboard() {
  const [mode, setMode] = useState("steady");
  const [isRunning, setIsRunning] = useState(false);
  const concurrency = MODES[mode];

  return (
    <div style={{
      fontFamily: "'DM Sans', sans-serif",
      background: "#F5F0E8",
      minHeight: "100vh",
      padding: "36px 40px",
      color: "#2D2519",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Playfair+Display:wght@400;600;700&display=swap" rel="stylesheet" />

      <div style={{ maxWidth: 920, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h1 style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: 26,
              fontWeight: 700,
              margin: 0,
              letterSpacing: "-0.02em",
            }}>
              Pipeline
            </h1>
            <span style={{ fontSize: 12, color: "#A89B8C" }}>Q2 2025 · FCC Compliance</span>
          </div>
        </div>

        {/* Controls bar */}
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}>
          {/* Mode toggle */}
          <div style={{ display: "flex", gap: 2, background: "#E8E0D4", borderRadius: 8, padding: 3 }}>
            {Object.entries(MODES).map(([key, val]) => (
              <button
                key={key}
                onClick={() => setMode(key)}
                style={{
                  padding: "7px 18px",
                  background: mode === key ? "#2D2519" : "transparent",
                  color: mode === key ? "#F5F0E8" : "#7A6E60",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 12.5,
                  fontFamily: "'DM Sans', sans-serif",
                  fontWeight: mode === key ? 600 : 400,
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                }}
              >
                {val.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div style={{ fontSize: 11.5, color: "#A89B8C" }}>
              <span style={{ color: "#4B7D8D", fontWeight: 600 }}>{concurrency.transcribe}</span>
              <span> transcribe · </span>
              <span style={{ color: "#6B8F71", fontWeight: 600 }}>{concurrency.summarize}</span>
              <span> summarize</span>
            </div>

            <button
              onClick={() => setIsRunning(!isRunning)}
              style={{
                padding: "8px 22px",
                background: isRunning ? "#D4634B" : "#2D2519",
                color: "#F5F0E8",
                border: "none",
                borderRadius: 8,
                fontSize: 12.5,
                fontFamily: "'DM Sans', sans-serif",
                fontWeight: 600,
                cursor: "pointer",
                transition: "background 0.25s ease",
                display: "flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              <span style={{ fontSize: 10 }}>{isRunning ? "■" : "▶"}</span>
              {isRunning ? "Stop" : "Run Pipeline"}
            </button>
          </div>
        </div>

        {/* Visualizer */}
        <div style={{
          background: "#FFFDF8",
          borderRadius: 14,
          padding: "18px 22px 14px",
          border: "1px solid #E2D9CA",
          marginBottom: 22,
        }}>
          <PipelineVisualizer mode={mode} isRunning={isRunning} />
        </div>

        {/* Stage cards */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
          {[
            { label: "Ingest", desc: "RSS → Episodes", color: [196, 145, 62], completed: 51, concurrent: null },
            { label: "Transcribe", desc: "Audio → Text", color: [75, 125, 141], completed: 25, concurrent: concurrency.transcribe },
            { label: "Summarize", desc: "Text → Insights", color: [107, 143, 113], completed: 17, concurrent: concurrency.summarize },
          ].map((s) => (
            <div key={s.label} style={{
              background: "#FFFDF8",
              borderRadius: 12,
              padding: "18px 22px",
              border: "1px solid #E2D9CA",
              borderTop: `3px solid ${rgbStr(s.color)}`,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 1 }}>{s.label}</div>
                  <div style={{ fontSize: 10.5, color: "#A89B8C" }}>{s.desc}</div>
                </div>
                <div style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: isRunning ? "rgb(74,222,128)" : "#C4B99A",
                  boxShadow: isRunning ? "0 0 8px rgba(74,222,128,0.5)" : "none",
                  transition: "all 0.4s ease",
                }} />
              </div>
              <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div>
                  <span style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: rgbStr(s.color) }}>
                    {s.completed}
                  </span>
                  <span style={{ fontSize: 10.5, color: "#A89B8C", marginLeft: 5 }}>completed</span>
                </div>
                {s.concurrent && (
                  <span style={{ fontSize: 10.5, color: "#A89B8C" }}>max {s.concurrent}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
