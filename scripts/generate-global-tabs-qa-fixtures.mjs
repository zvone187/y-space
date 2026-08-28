import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(repositoryRoot, "implementation assets", "qa-fixture");
mkdirSync(fixtureDirectory, { recursive: true });

writeFileSync(
  join(fixtureDirectory, "workspace-one.ts"),
  [
    'export const workspaceTabMessage = "Y Space source tab one";',
    "",
    "export function describeWorkspaceTab(): string {",
    "  return workspaceTabMessage;",
    "}",
    "",
  ].join("\n"),
);
writeFileSync(
  join(fixtureDirectory, "workspace-two.md"),
  "# Y Space document tab\n\nThis fixture verifies a second in-app source document.\n",
);
writeFileSync(
  join(fixtureDirectory, "customers.csv"),
  "Name,Plan,Active\nAda,Pro,true\nGrace,Team,true\nLinus,Free,false\n",
);
writeFileSync(
  join(fixtureDirectory, "metrics.tsv"),
  "Metric\tAugust\tSeptember\nTasks\t14\t21\nTabs\t3\t8\n",
);

function createPdf() {
  const pageOne = "BT /F1 24 Tf 72 720 Td (Y Space global PDF tab - page 1) Tj ET";
  const pageTwo = "BT /F1 24 Tf 72 720 Td (Embedded document preview - page 2) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${Buffer.byteLength(pageOne)} >>\nstream\n${pageOne}\nendstream`,
    `<< /Length ${Buffer.byteLength(pageTwo)} >>\nstream\n${pageTwo}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n%YSPACE\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

writeFileSync(join(fixtureDirectory, "workspace-preview.pdf"), createPdf(), "binary");

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.aoa_to_sheet([
    ["Name", "Role", "Status"],
    ["Ada", "Engineer", "Active"],
    ["Grace", "Researcher", "Active"],
  ]),
  "People",
);
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.aoa_to_sheet([
    ["Month", "Tasks", "Browser tabs"],
    ["August", 14, 3],
    ["September", 21, 8],
  ]),
  "Metrics",
);
writeFileSync(
  join(fixtureDirectory, "workspace-preview.xlsx"),
  XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }),
);
writeFileSync(
  join(fixtureDirectory, "workspace-preview.xls"),
  XLSX.write(workbook, { type: "buffer", bookType: "biff8" }),
);
writeFileSync(join(fixtureDirectory, "malformed.xlsx"), "not a workbook\n");

process.stdout.write(`Generated global workspace QA fixtures in ${fixtureDirectory}\n`);
