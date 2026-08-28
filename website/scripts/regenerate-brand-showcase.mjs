#!/usr/bin/env node
// Replace obsolete product captures with neutral Y Space showcase artwork.
// Real release captures can overwrite these files without changing site code.
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const WEBSITE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(WEBSITE_DIR, "public");

const artifacts = [
  {
    file: "hero-screenshot.png",
    width: 2920,
    height: 1840,
    title: "Y Space",
    subtitle: "Agents, browser, and integrations in one workspace",
  },
  {
    file: "sf-experiment.png",
    width: 2920,
    height: 1800,
    title: "Parallel experiments",
    subtitle: "Compare agent approaches side by side",
  },
  {
    file: "sf-notes.png",
    width: 700,
    height: 1554,
    title: "Project notes",
    subtitle: "Keep context beside every task",
  },
  {
    file: "sf-acp.png",
    width: 2948,
    height: 1554,
    title: "Agent runtime",
    subtitle: "Connect Codex, Claude Code, and OpenCode",
  },
  {
    file: "sf-mcp.png",
    width: 1500,
    height: 551,
    title: "Connections",
    subtitle: "Bring tools and integrations into every agent",
  },
  {
    file: "sf-schedules.png",
    width: 1510,
    height: 850,
    title: "Schedules",
    subtitle: "Run recurring work from your desktop workspace",
  },
  {
    file: "release-1.4.0.png",
    width: 1200,
    height: 630,
    title: "Y Space",
    subtitle: "A shared desktop workspace for coding agents",
  },
];

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showcaseSvg({ width, height, title, subtitle }) {
  const unit = Math.min(width, height);
  const titleSize = Math.round(unit * 0.085);
  const subtitleSize = Math.round(unit * 0.026);
  const markSize = Math.round(unit * 0.19);
  const centerX = width / 2;
  const centerY = height / 2;
  const panelX = width * 0.075;
  const panelY = height * 0.09;
  const panelWidth = width * 0.85;
  const panelHeight = height * 0.82;
  const markTop = centerY - markSize * 1.05;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#070709"/>
  <rect x="${panelX}" y="${panelY}" width="${panelWidth}" height="${panelHeight}" rx="${unit * 0.04}" fill="#0E0E14" stroke="#242430" stroke-width="${Math.max(2, unit * 0.002)}"/>
  <path d="M${panelX + unit * 0.08} ${panelY + unit * 0.12}H${panelX + panelWidth - unit * 0.08}" stroke="#242430" stroke-width="${Math.max(2, unit * 0.002)}"/>
  <circle cx="${panelX + unit * 0.04}" cy="${panelY + unit * 0.06}" r="${unit * 0.009}" fill="#FF5A1F"/>
  <circle cx="${panelX + unit * 0.07}" cy="${panelY + unit * 0.06}" r="${unit * 0.009}" fill="#343442"/>
  <circle cx="${panelX + unit * 0.1}" cy="${panelY + unit * 0.06}" r="${unit * 0.009}" fill="#343442"/>
  <g transform="translate(${centerX - markSize / 2} ${markTop}) scale(${markSize / 1024})">
    <path fill="#EAF0FB" d="M278 270H430L512 414L594 270H746L582 550V760H442V550L278 270Z"/>
    <circle cx="704" cy="704" r="46" fill="#FF5A1F"/>
  </g>
  <text x="${centerX}" y="${centerY + markSize * 0.32}" text-anchor="middle" font-family="Geist, Inter, system-ui, sans-serif" font-weight="650" font-size="${titleSize}" letter-spacing="-${titleSize * 0.035}" fill="#EAF0FB">${escapeXml(title)}</text>
  <text x="${centerX}" y="${centerY + markSize * 0.7}" text-anchor="middle" font-family="Geist, Inter, system-ui, sans-serif" font-weight="400" font-size="${subtitleSize}" fill="#9BA6BE">${escapeXml(subtitle)}</text>
</svg>`;
}

for (const artifact of artifacts) {
  const rendered = await sharp(Buffer.from(showcaseSvg(artifact)))
    .png()
    .toBuffer();
  await writeFile(resolve(PUBLIC_DIR, artifact.file), rendered);
}

console.log(`Regenerated ${artifacts.length} Y Space showcase artifacts.`);
