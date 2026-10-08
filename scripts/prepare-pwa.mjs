import { readdir, writeFile } from "node:fs/promises";
const assets = (await readdir("dist/assets")).map((name) => "/assets/" + name);
await writeFile(
  "dist/shell-assets.json",
  JSON.stringify(["/", "/icon.svg", "/manifest.webmanifest", ...assets]),
);
