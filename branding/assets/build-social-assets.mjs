// Regenerate public social artwork from the Y Space SVG sources.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = fileURLToPath(new URL("./social/x/", import.meta.url));

async function png(sourceName, size) {
  return sharp(await readFile(`${HERE}${sourceName}`), { density: 512 })
    .resize(size.width, size.height, { fit: "cover" })
    .png()
    .toBuffer();
}

async function jpeg(sourceName, size) {
  return sharp(await readFile(`${HERE}${sourceName}`), { density: 512 })
    .resize(size.width, size.height, { fit: "cover" })
    .flatten({ background: "#070709" })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

await Promise.all([
  writeFile(`${HERE}avatar-1024.png`, await png("avatar.svg", { width: 1024, height: 1024 })),
  writeFile(`${HERE}avatar-400.png`, await png("avatar.svg", { width: 400, height: 400 })),
  writeFile(`${HERE}avatar-400.jpg`, await jpeg("avatar.svg", { width: 400, height: 400 })),
  writeFile(`${HERE}avatar-800.jpg`, await jpeg("avatar.svg", { width: 800, height: 800 })),
  writeFile(
    `${HERE}avatar-tight-1024.png`,
    await png("avatar-tight.svg", { width: 1024, height: 1024 }),
  ),
  writeFile(
    `${HERE}avatar-tight-400.png`,
    await png("avatar-tight.svg", { width: 400, height: 400 }),
  ),
  writeFile(
    `${HERE}avatar-tight-400.jpg`,
    await jpeg("avatar-tight.svg", { width: 400, height: 400 }),
  ),
  writeFile(
    `${HERE}avatar-tight-circlepreview.png`,
    await png("avatar-tight.svg", { width: 400, height: 400 }),
  ),
  writeFile(`${HERE}header-1500x500.png`, await png("header.svg", { width: 1500, height: 500 })),
  writeFile(`${HERE}header-1500x500.jpg`, await jpeg("header.svg", { width: 1500, height: 500 })),
]);

console.log("Regenerated Y Space social assets.");
