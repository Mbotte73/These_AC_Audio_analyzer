// Assemble la page autonome de la cabine H145 : insère three.js (r160, build/three.min.js)
// à la place du marqueur /*THREE*/ du gabarit. La page produite fonctionne hors ligne, par double-clic.
// Usage : npm install (installe three 0.160.0), puis npm run construire-cabine
const fs = require("fs");
const path = require("path");

const ici = __dirname;
const gabarit = fs.readFileSync(path.join(ici, "source", "cabine_template.html"), "utf8");
const dossierThree = path.join(ici, "..", "..", "node_modules", "three");
const three = fs.readFileSync(path.join(dossierThree, "build", "three.min.js"), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(dossierThree, "package.json"), "utf8")).version;
if (version !== "0.160.0") console.warn(`Attention : three ${version} installé, la page a été validée avec 0.160.0.`);
if (gabarit.split("/*THREE*/").length !== 2) throw new Error("Le gabarit doit contenir exactement un marqueur /*THREE*/.");
const sortie = path.join(ici, "cabine_H145_niveaux_sonores.html");
fs.writeFileSync(sortie, gabarit.replace("/*THREE*/", () => three));
console.log(`Page écrite : ${sortie} (${(fs.statSync(sortie).size / 1024).toFixed(0)} Ko)`);
