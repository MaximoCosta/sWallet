// The static app is edited at the repo root (index.html, style.css, app.js, js/) and served by Next from public/.
// This copies the root sources into public/ so both stay identical. Runs before every build.
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");

for (const file of ["index.html", "style.css", "app.js"]) {
  cpSync(join(root, file), join(publicDir, file));
}

const sourceJs = join(root, "js");
const targetJs = join(publicDir, "js");
rmSync(targetJs, { recursive: true, force: true });
mkdirSync(targetJs, { recursive: true });
cpSync(sourceJs, targetJs, { recursive: true });

const count = (dir) => readdirSync(dir).reduce((total, name) => {
  const path = join(dir, name);
  return total + (statSync(path).isDirectory() ? count(path) : 1);
}, 0);
console.log(`public/ actualizado: 3 archivos + ${count(targetJs)} modulos JS`);
