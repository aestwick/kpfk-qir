import { useState } from "react";

// ─── Data ───────────────────────────────────────────────────────────
const EPISODES = [
  { id: 1, show: "Democracy Now!", host: "Amy Goodman", date: "Jun 26", issue: "Middle East / War & Peace", status: "summarized", duration: "27m" },
  { id: 2, show: "Beneath The Surface", host: "Suzi Weissman", date: "Jun 29", issue: "Politics & History", status: "summarized", duration: "57m" },
  { id: 3, show: "Beneath The Surface", host: "Suzi Weissman", date: "Jun 22", issue: "Middle East / War & Peace", status: "summarized", duration: "57m" },
  { id: 4, show: "Beneath The Surface", host: "Suzi Weissman", date: "Jun 8", issue: "Politics & History", status: "summarized", duration: "27m" },
  { id: 5, show: "Conversations On the Way", host: "Nana Gyamfi", date: "Jun 4", issue: "Minority Group Issues", status: "summarized", duration: "57m" },
  { id: 6, show: "Beneath The Surface", host: "Suzi Weissman", date: "May 25", issue: "Politics & History", status: "summarized", duration: "57m" },
  { id: 7, show: "Beneath The Surface", host: "Suzi Weissman", date: "May 18", issue: "Middle East / War & Peace", status: "summarized", duration: "57m" },
  { id: 8, show: "Background Briefing", host: "Ian Masters", date: "May 13", issue: "Middle East / War & Peace", status: "summarized", duration: "57m" },
  { id: 9, show: "Chris Hedges Report", host: "Chris Hedges", date: "May 17", issue: "Politics & History", status: "summarized", duration: "57m" },
  { id: 10, show: "Malcolm X Centennial", host: "Pacifica Archives", date: "May 19", issue: "Minority Group Issues", status: "summarized", duration: "117m" },
];

const ISSUES = [
  { name: "Middle East / War & Peace", count: 8, color: "#D4634B" },
  { name: "Politics & History", count: 9, color: "#4B7D8D" },
  { name: "Minority Group Issues", count: 5, color: "#C4913E" },
  { name: "Miscellaneous", count: 7, color: "#6B8F71" },
];

const PIPELINE_STEPS = [
  { name: "Ingest", desc: "RSS → Episodes", icon: "📡", completed: 51, status: "idle" },
  { name: "Transcribe", desc: "Audio → Text", icon: "🎙", completed: 25, status: "idle" },
  { name: "Summarize", desc: "Text → Insights", icon: "✨", completed: 17, status: "idle" },
];

// ─── Components ─────────────────────────────────────────────────────

const StatusDot = ({ status }) => {
  const colors = {
    idle: "#888",
    running: "#4ADE80",
    error: "#EF4444",
    summarized: "#4B7D8D",
    transcribed: "#C4913E",
    pending: "#888",
  };
  return (
    <span style={{
      display: "inline-block",
      width: 8,
      height: 8,
      borderRadius: "50%",
      backgroundColor: colors[status] || "#888",
      marginRight: 6,
    }} />
  );
};

const ProgressRing = ({ value, max, size = 120 }) => {
  const pct = max > 0 ? value / max : 0;
  const r = (size - 12) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#E8E0D4" strokeWidth={10} />
      <circle
        cx={size/2} cy={size/2} r={r} fill="none"
        stroke="#4B7D8D" strokeWidth={10}
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct)}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 1s ease" }}
      />
    </svg>
  );
};

const IssueBar = ({ issue, maxCount }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#5A4F42" }}>
      <span>{issue.name}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{issue.count}</span>
    </div>
    <div style={{ height: 6, background: "#E8E0D4", borderRadius: 3, overflow: "hidden" }}>
      <div style={{
        height: "100%",
        width: `${(issue.count / maxCount) * 100}%`,
        background: issue.color,
        borderRadius: 3,
        transition: "width 0.8s ease",
      }} />
    </div>
  </div>
);

export default function QIRDashboard() {
  const [activeNav, setActiveNav] = useState("overview");
  const [quarter] = useState("Q2 2025");

  const navItems = [
    { id: "overview", label: "Overview", icon: "◉" },
    { id: "episodes", label: "Episodes", icon: "▶" },
    { id: "jobs", label: "Jobs", icon: "⚙" },
    { id: "activity", label: "Activity", icon: "↗" },
    { id: "usage", label: "Usage", icon: "◧" },
    { id: "generate", label: "Generate QIR", icon: "★" },
    { id: "downloads", label: "Downloads", icon: "↓" },
  ];

  const maxIssueCount = Math.max(...ISSUES.map(i => i.count));

  return (
    <div style={{
      fontFamily: "'DM Sans', sans-serif",
      minHeight: "100vh",
      display: "flex",
      background: "#F5F0E8",
      color: "#2D2519",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Playfair+Display:wght@400;600;700&display=swap" rel="stylesheet" />

      {/* ─── Sidebar ─────────────────────────────────────── */}
      <aside style={{
        width: 220,
        background: "#2D2519",
        color: "#F5F0E8",
        display: "flex",
        flexDirection: "column",
        padding: "28px 0",
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ padding: "0 24px", marginBottom: 40 }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
            QIR
          </div>
          <div style={{ fontSize: 11, color: "#A89B8C", marginTop: 4, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            KPFK 90.7 FM
          </div>
          <div style={{ fontSize: 10, color: "#6B5F52", marginTop: 2 }}>
            FCC Compliance Pipeline
          </div>
        </div>

        {/* Quarter Selector */}
        <div style={{ padding: "0 16px", marginBottom: 24 }}>
          <div style={{
            background: "#3D3229",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 13,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            cursor: "pointer",
          }}>
            <span style={{ fontWeight: 600 }}>{quarter}</span>
            <span style={{ fontSize: 10, color: "#A89B8C" }}>Apr–Jun 2025</span>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1 }}>
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 24px",
                background: activeNav === item.id ? "#3D3229" : "transparent",
                border: "none",
                borderLeft: activeNav === item.id ? "3px solid #C4913E" : "3px solid transparent",
                color: activeNav === item.id ? "#F5F0E8" : "#A89B8C",
                fontSize: 13,
                fontFamily: "'DM Sans', sans-serif",
                fontWeight: activeNav === item.id ? 600 : 400,
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s ease",
              }}
            >
              <span style={{ fontSize: 14, width: 18, textAlign: "center", opacity: 0.7 }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Settings + User */}
        <div style={{ padding: "0 24px", borderTop: "1px solid #3D3229", paddingTop: 16 }}>
          <button style={{
            display: "flex", alignItems: "center", gap: 10, background: "none", border: "none",
            color: "#A89B8C", fontSize: 13, fontFamily: "'DM Sans', sans-serif", cursor: "pointer", padding: "6px 0",
          }}>
            <span style={{ fontSize: 14 }}>⚙</span> Settings
          </button>
          <div style={{ marginTop: 16, fontSize: 12, color: "#6B5F52" }}>
            ace@kpfk.org
          </div>
        </div>
      </aside>

      {/* ─── Main Content ────────────────────────────────── */}
      <main style={{ flex: 1, padding: "32px 40px", overflowY: "auto", maxHeight: "100vh" }}>

        {/* Header */}
        <header style={{ marginBottom: 36, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: 32,
              fontWeight: 700,
              margin: 0,
              letterSpacing: "-0.02em",
              color: "#2D2519",
            }}>
              Quarterly Issues Report
            </h1>
            <p style={{ margin: "6px 0 0", fontSize: 14, color: "#7A6E60" }}>
              Q2 2025 — April 1 through June 30, 2025
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={{
              padding: "10px 20px",
              background: "#2D2519",
              color: "#F5F0E8",
              border: "none",
              borderRadius: 8,
              fontSize: 13,
              fontFamily: "'DM Sans', sans-serif",
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}>
              ★ Generate QIR
            </button>
            <button style={{
              padding: "10px 20px",
              background: "transparent",
              color: "#2D2519",
              border: "1.5px solid #C4B99A",
              borderRadius: 8,
              fontSize: 13,
              fontFamily: "'DM Sans', sans-serif",
              fontWeight: 500,
              cursor: "pointer",
            }}>
              Export PDF
            </button>
          </div>
        </header>

        {/* ─── Pipeline Status ────────────────────────────── */}
        <section style={{
          background: "#FFFDF8",
          borderRadius: 14,
          padding: "24px 28px",
          marginBottom: 24,
          border: "1px solid #E2D9CA",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, textTransform: "uppercase", letterSpacing: "0.06em", color: "#7A6E60" }}>
              Pipeline
            </h2>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <StatusDot status="idle" />
              <span style={{ fontSize: 12, color: "#A89B8C" }}>All stages idle</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 0, alignItems: "center" }}>
            {PIPELINE_STEPS.map((step, i) => (
              <div key={step.name} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                <div style={{
                  flex: 1,
                  background: "#F5F0E8",
                  borderRadius: 10,
                  padding: "16px 20px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  border: "1px solid #E8E0D4",
                }}>
                  <div>
                    <div style={{ fontSize: 20, marginBottom: 4 }}>{step.icon}</div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{step.name}</div>
                    <div style={{ fontSize: 11, color: "#A89B8C", marginTop: 2 }}>{step.desc}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#4B7D8D" }}>{step.completed}</div>
                    <div style={{ fontSize: 10, color: "#A89B8C", textTransform: "uppercase", letterSpacing: "0.05em" }}>completed</div>
                  </div>
                </div>
                {i < PIPELINE_STEPS.length - 1 && (
                  <div style={{ width: 32, textAlign: "center", color: "#C4B99A", fontSize: 16, flexShrink: 0 }}>→</div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            {PIPELINE_STEPS.map(step => (
              <button key={step.name} style={{
                padding: "7px 16px",
                background: "#2D2519",
                color: "#F5F0E8",
                border: "none",
                borderRadius: 6,
                fontSize: 12,
                fontFamily: "'DM Sans', sans-serif",
                fontWeight: 500,
                cursor: "pointer",
              }}>
                Run {step.name}
              </button>
            ))}
          </div>
        </section>

        {/* ─── Stats Row ──────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, marginBottom: 24 }}>

          {/* Progress Card */}
          <div style={{
            background: "#FFFDF8",
            borderRadius: 14,
            padding: "24px 28px",
            border: "1px solid #E2D9CA",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#7A6E60", margin: "0 0 16px", alignSelf: "flex-start" }}>
              Quarter Progress
            </h3>
            <div style={{ position: "relative", display: "inline-block" }}>
              <ProgressRing value={29} max={29} size={110} />
              <div style={{
                position: "absolute", inset: 0, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
              }}>
                <span style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>29</span>
                <span style={{ fontSize: 10, color: "#A89B8C", marginTop: 2 }}>episodes</span>
              </div>
            </div>
            <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: "#4B7D8D" }}>100% Complete</div>
            <div style={{ fontSize: 11, color: "#A89B8C", marginTop: 2 }}>29 of 29 episodes processed</div>
          </div>

          {/* Cost Card */}
          <div style={{
            background: "#FFFDF8",
            borderRadius: 14,
            padding: "24px 28px",
            border: "1px solid #E2D9CA",
          }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#7A6E60", margin: "0 0 20px" }}>
              Cost This Quarter
            </h3>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 36, fontWeight: 700, marginBottom: 4 }}>
              $2.98
            </div>
            <div style={{ fontSize: 12, color: "#A89B8C", marginBottom: 20 }}>
              $0.10 per episode
            </div>
            <div style={{ display: "flex", gap: 20, marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: "#4B7D8D", display: "inline-block" }} />
                Groq — $2.93
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: "#C4913E", display: "inline-block" }} />
                OpenAI — $0.05
              </div>
            </div>
            {/* Mini bar */}
            <div style={{ height: 8, borderRadius: 4, overflow: "hidden", display: "flex", background: "#E8E0D4" }}>
              <div style={{ width: "98.3%", background: "#4B7D8D", borderRadius: "4px 0 0 4px" }} />
              <div style={{ width: "1.7%", background: "#C4913E", borderRadius: "0 4px 4px 0" }} />
            </div>
            <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", fontSize: 11, color: "#A89B8C" }}>
              <span>29 episodes</span>
              <span>58 API calls</span>
            </div>
          </div>

          {/* Processing Time Card */}
          <div style={{
            background: "#FFFDF8",
            borderRadius: 14,
            padding: "24px 28px",
            border: "1px solid #E2D9CA",
          }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#7A6E60", margin: "0 0 20px" }}>
              Avg Processing Time
            </h3>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontSize: 13 }}>
                <span>Transcribe</span>
                <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#4B7D8D" }}>54.6m</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: "#E8E0D4", overflow: "hidden" }}>
                <div style={{ height: "100%", width: "85%", background: "linear-gradient(90deg, #4B7D8D, #6BA3B3)", borderRadius: 4 }} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, textAlign: "center" }}>
              {[
                { label: "Ingest", val: "51" },
                { label: "Transcribe", val: "25" },
                { label: "Summarize", val: "17" },
              ].map(q => (
                <div key={q.label}>
                  <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{q.val}</div>
                  <div style={{ fontSize: 10, color: "#A89B8C", textTransform: "uppercase", letterSpacing: "0.04em" }}>{q.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ─── Issues + Recent Episodes ───────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 20 }}>

          {/* Issues Breakdown */}
          <div style={{
            background: "#FFFDF8",
            borderRadius: 14,
            padding: "24px 28px",
            border: "1px solid #E2D9CA",
          }}>
            <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#7A6E60", margin: "0 0 20px" }}>
              Issues Coverage
            </h3>
            <div style={{ marginBottom: 8, fontSize: 11, color: "#A89B8C" }}>
              {ISSUES.reduce((a, i) => a + i.count, 0)} episodes across {ISSUES.length} issue categories
            </div>
            <div style={{ marginTop: 16 }}>
              {ISSUES.map(issue => (
                <IssueBar key={issue.name} issue={issue} maxCount={maxIssueCount} />
              ))}
            </div>
            <div style={{
              marginTop: 20,
              padding: "12px 14px",
              background: "#F5F0E8",
              borderRadius: 8,
              fontSize: 11,
              color: "#7A6E60",
              lineHeight: 1.5,
            }}>
              FCC recommends 5–10 issues per quarter. Current coverage spans {ISSUES.length} broad categories with {ISSUES.reduce((a, i) => a + i.count, 0)} documented programs.
            </div>
          </div>

          {/* Recent Episodes */}
          <div style={{
            background: "#FFFDF8",
            borderRadius: 14,
            padding: "24px 28px",
            border: "1px solid #E2D9CA",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#7A6E60", margin: 0 }}>
                Recent Episodes
              </h3>
              <button style={{
                background: "none", border: "none", color: "#4B7D8D", fontSize: 12,
                fontFamily: "'DM Sans', sans-serif", fontWeight: 600, cursor: "pointer",
              }}>
                View all →
              </button>
            </div>
            <div>
              {EPISODES.slice(0, 7).map((ep, i) => (
                <div
                  key={ep.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "60px 1.4fr 1fr 1fr 60px",
                    alignItems: "center",
                    padding: "11px 0",
                    borderBottom: i < 6 ? "1px solid #EDE6DA" : "none",
                    fontSize: 13,
                    gap: 12,
                  }}
                >
                  <span style={{ color: "#A89B8C", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{ep.date}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{ep.show}</div>
                    <div style={{ fontSize: 11, color: "#A89B8C" }}>{ep.host}</div>
                  </div>
                  <span style={{
                    fontSize: 11,
                    color: ISSUES.find(i => i.name === ep.issue)?.color || "#7A6E60",
                    fontWeight: 500,
                  }}>
                    {ep.issue}
                  </span>
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    color: "#4B7D8D",
                    fontWeight: 500,
                  }}>
                    <StatusDot status={ep.status} />
                    {ep.status}
                  </span>
                  <span style={{ color: "#A89B8C", fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ep.duration}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ─── Footer ─────────────────────────────────────── */}
        <footer style={{
          marginTop: 32,
          paddingTop: 20,
          borderTop: "1px solid #E2D9CA",
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "#A89B8C",
        }}>
          <span>KPFK 90.7 FM Los Angeles / 98.7 FM Santa Barbara — Pacifica Foundation</span>
          <span>QIR due by July 10, 2025</span>
        </footer>
      </main>
    </div>
  );
}
