// Petit serveur statique sans dependance (http/fs/path du coeur de Node
// uniquement), utilise seulement pour faire tourner les tests Playwright en
// local. L'outil deploye (index.html) n'en a pas besoin : sur GitHub Pages
// ou en local via double-clic, il fonctionne directement.
const http = require("http");
const fs = require("fs");
const path = require("path");

const RACINE = path.resolve(__dirname, "..");
const PORT = 4173;

const TYPES_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};

const serveur = http.createServer((req, res) => {
  let chemin = decodeURIComponent(req.url.split("?")[0]);
  if (chemin === "/") chemin = "/index.html";
  const cheminAbsolu = path.join(RACINE, chemin);
  if (!cheminAbsolu.startsWith(RACINE)) { res.writeHead(403); res.end("Interdit"); return; }
  fs.readFile(cheminAbsolu, (err, data) => {
    if (err) { res.writeHead(404); res.end("Introuvable : " + chemin); return; }
    const ext = path.extname(cheminAbsolu);
    res.writeHead(200, { "Content-Type": TYPES_MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

serveur.listen(PORT, "127.0.0.1", () => {
  console.log(`Serveur statique de test sur http://127.0.0.1:${PORT}`);
});
