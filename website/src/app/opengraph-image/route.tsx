import { ImageResponse } from "next/og";

import { SITE_URL } from "@/lib/seo";

// A stable explicit route avoids Next's hashed metadata-file URLs under route
// groups while retaining a build-cacheable 1.91:1 social card.
export const dynamic = "force-static";

const size = { width: 1200, height: 630 };

const AGENTS = ["Claude", "Codex", "Gemini", "Cursor", "OpenCode", "Copilot"];

export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0a0a0a",
        backgroundImage:
          "radial-gradient(900px circle at 50% 0%, rgba(255,255,255,0.10), transparent 60%)",
        color: "#ffffff",
        padding: "64px",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 124,
          fontWeight: 800,
          letterSpacing: "-0.04em",
          backgroundImage: "linear-gradient(120deg, #ffffff 20%, #9ca3af 100%)",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        Y Space
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 24,
          fontSize: 40,
          color: "#d1d5db",
          textAlign: "center",
          maxWidth: 920,
        }}
      >
        Universal orchestrator for AI coding agents
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 14,
          marginTop: 48,
        }}
      >
        {AGENTS.map((name) => (
          <div
            key={name}
            style={{
              display: "flex",
              fontSize: 26,
              color: "#e5e7eb",
              padding: "10px 22px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.14)",
              backgroundColor: "rgba(255,255,255,0.04)",
            }}
          >
            {name}
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 56,
          fontSize: 26,
          color: "#6b7280",
        }}
      >
        {SITE_URL.replace("https://", "")} · Free & open source · macOS · Windows · Linux
      </div>
    </div>,
    { ...size },
  );
}
