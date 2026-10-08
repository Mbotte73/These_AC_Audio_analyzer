// Titres d'axes des graphiques (tracerCourbe, tracerSpectrogramme) : le
// titre vertical etait dessine a partir de M.t+10 vers le haut du canvas, et
// se trouvait coupe ("niveau (d") des qu'une legende reduisait la place
// disponible (onglet Comparaison). On espionne ctx.fillText pour calculer la
// boite reelle de chaque texte dessine (rotation et devicePixelRatio
// compris) et on verifie qu'un titre d'axe est entier, reste dans le canvas
// et ne chevauche aucun autre texte (graduations, legende, titre).
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

async function espionnerTextes(page) {
  await page.addInitScript(() => {
    window.__textes = [];
    const origine = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (texte, x, y, ...reste) {
      const m = this.measureText(texte);
      const t = this.getTransform();
      const coins = [
        [x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent], [x + m.actualBoundingBoxRight, y - m.actualBoundingBoxAscent],
        [x - m.actualBoundingBoxLeft, y + m.actualBoundingBoxDescent], [x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent],
      ].map(([a, b]) => t.transformPoint(new DOMPoint(a, b)));
      const xs = coins.map(p => p.x), ys = coins.map(p => p.y);
      window.__textes.push({
        canvas: this.canvas.id, texte: String(texte), tourne: Math.abs(t.b) > 1e-6, alignement: this.textAlign,
        x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
        largeur: this.canvas.width, hauteur: this.canvas.height,
      });
      return origine.call(this, texte, x, y, ...reste);
    };
  });
}

// Textes du dernier dessin complet de chaque canvas demande (on vide le
// releve, on redessine l'onglet actif, puis on attend que chaque canvas ait
// ete redessine).
async function textesApresRedessin(page, ids) {
  await page.evaluate(() => { window.__textes = []; rafraichirOngletActif(); });
  await page.waitForFunction(ids => ids.every(id => window.__textes.some(t => t.canvas === id)), ids);
  return page.evaluate(ids => window.__textes.filter(t => ids.includes(t.canvas)), ids);
}

function seChevauchent(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// Verifie le titre vertical (attendu en entier) et le titre horizontal d'un
// canvas : dans le canvas, sans chevauchement avec les autres textes.
function verifierTitresAxes(textes, idCanvas, ylabelAttendu, xlabelAttendu) {
  const duCanvas = textes.filter(t => t.canvas === idCanvas);
  const titreY = duCanvas.filter(t => t.tourne);
  expect(titreY.map(t => t.texte), `${idCanvas} : titre vertical`).toEqual([ylabelAttendu]);
  const titreX = duCanvas.filter(t => t.texte === xlabelAttendu);
  expect(titreX.length, `${idCanvas} : titre horizontal`).toBe(1);
  for (const titre of [titreY[0], titreX[0]]) {
    expect(titre.x0, `${idCanvas} « ${titre.texte} » bord gauche`).toBeGreaterThanOrEqual(0);
    expect(titre.y0, `${idCanvas} « ${titre.texte} » bord haut`).toBeGreaterThanOrEqual(0);
    expect(titre.x1, `${idCanvas} « ${titre.texte} » bord droit`).toBeLessThanOrEqual(titre.largeur);
    expect(titre.y1, `${idCanvas} « ${titre.texte} » bord bas`).toBeLessThanOrEqual(titre.hauteur);
    for (const autre of duCanvas) {
      if (autre === titre) continue;
      expect(seChevauchent(titre, autre), `${idCanvas} : « ${titre.texte} » chevauche « ${autre.texte} »`).toBe(false);
    }
  }
}

async function chargerMesure(page, splParVoie) {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-axes-"));
  const wavPath = path.join(dir, "mesure.wav");
  const txtPath = path.join(dir, "mesure.txt");
  const { fs, canaux: base } = genererTonPur({ freqHz: 1000, niveauDbfsRms: 0, dureeS: 3, nCh: 1 });
  const canaux = [-20, -26, -32, -38].map(n => base[0].map(x => x * Math.pow(10, n / 20)));
  ecrireWavFichier(wavPath, fs, canaux);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt(splParVoie));
  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
}

for (const [mode, viewport] of [["bureau", { width: 1280, height: 900 }], ["mobile 360 px", { width: 360, height: 780 }]]) {
  test.describe(`titres d'axes entiers (${mode})`, () => {
    test.use({ viewport });

    test("onglet Comparaison (légende à 4 voies) : « niveau (dB SPL) » entier sur les deux graphiques", async ({ page }) => {
      await espionnerTextes(page);
      await chargerMesure(page, [100, 100, 100, 100]);
      await page.locator('#tabsNav button[data-onglet="comparaison"]').click();
      const ids = ["c-comparaison-spectre", "c-comparaison-niveaux"];
      const textes = await textesApresRedessin(page, ids);
      verifierTitresAxes(textes, "c-comparaison-spectre", "niveau (dB SPL)", "fréquence (Hz)");
      verifierTitresAxes(textes, "c-comparaison-niveaux", "niveau (dB SPL)", "temps (s)");
    });

    test("onglet Vol : « altitude (m) » entier, graduations de l'accélération distinctes avec décimales", async ({ page }) => {
      await espionnerTextes(page);
      await chargerMesure(page, [100, 100, 100, 100]);
      await page.locator('#tabsNav button[data-onglet="vol"]').click();
      const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-axes-vol-"));
      const gps = ["Time (s),Latitude (°),Longitude (°),Height (m)"];
      const accel = ["Time (s),Linear Acceleration x (m/s^2),Linear Acceleration y (m/s^2),Linear Acceleration z (m/s^2)"];
      for (let i = 0; i <= 3; i++) {
        gps.push(`${i},${45 + i * 0.001},${5 + i * 0.001},${1000 + 10 * i}`);
        accel.push(`${i},${2 + 0.45 * i},0,0`); // magnitude de 2 a 3,35 m/s² : pas de graduation inferieur a 1
      }
      fsNode.writeFileSync(path.join(dir, "gps.csv"), gps.join("\n"));
      fsNode.writeFileSync(path.join(dir, "accel1.csv"), accel.join("\n"));
      const depots = page.locator("#contenu-vol .vol-depot");
      await depots.nth(0).locator('input[type="file"]').setInputFiles(path.join(dir, "gps.csv"));
      await expect(depots.nth(0).locator(".filename")).toContainText("gps.csv");
      await depots.nth(1).locator('input[type="file"]').setInputFiles(path.join(dir, "accel1.csv"));
      await expect(depots.nth(1).locator(".filename")).toContainText("accel1.csv");

      const ids = ["c-vol-altitude", "c-vol-accel"];
      const textes = await textesApresRedessin(page, ids);
      verifierTitresAxes(textes, "c-vol-altitude", "altitude (m)", "temps (min)");
      verifierTitresAxes(textes, "c-vol-accel", "accélération (m/s²)", "temps (min)");

      const graduationsY = textes.filter(t => t.canvas === "c-vol-accel" && !t.tourne && t.alignement === "right" && /^-?\d/.test(t.texte)).map(t => t.texte);
      expect(graduationsY.length).toBeGreaterThanOrEqual(4);
      expect(new Set(graduationsY).size, `graduations : ${graduationsY.join(", ")}`).toBe(graduationsY.length);
      for (const g of graduationsY) expect(g).toMatch(/^\d+\.\d$/);
    });

    test("onglet Voie : niveau dans le temps, spectre et spectrogramme, voie non étalonnée (unité longue)", async ({ page }) => {
      await espionnerTextes(page);
      await chargerMesure(page, [null, null, null, null]);
      const ids = ["c-temps-0", "c-spectre-0", "c-spectro-0"];
      const textes = await textesApresRedessin(page, ids);
      verifierTitresAxes(textes, "c-temps-0", "niveau (dBFS (non calibré))", "temps (s)");
      verifierTitresAxes(textes, "c-spectre-0", "niveau (dBFS (non calibré))", "fréquence (Hz)");
      verifierTitresAxes(textes, "c-spectro-0", "fréquence (Hz)", "temps (s)");
    });
  });
}

test("titre vertical plus long que la zone de tracé : raccourci avec une ellipse, sans déborder ni chevaucher les graduations « -150 »", async ({ page }) => {
  await espionnerTextes(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/index.html");
  const textes = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.id = "c-test-ellipse";
    c.style.cssText = "width:312px; height:150px; display:block;";
    document.body.appendChild(c);
    window.__textes = [];
    const xs = [0, 1, 2, 3], ys1 = [-150, -120, -110, -100], ys2 = [-140, -130, -125, -105];
    tracerCourbe(c, [{ xs, ys: ys1, couleur: "#0f4c5c", label: "Voie 1" }, { xs, ys: ys2, couleur: "#c98a3b", label: "Voie 2" }],
      { titre: "Test", xlabel: "temps (s)", ylabel: "niveau sonore pondéré A, moyenne glissante sur une seconde (dB SPL)" });
    return window.__textes.filter(t => t.canvas === "c-test-ellipse");
  });
  const titreY = textes.find(t => t.tourne);
  expect(titreY.texte.endsWith("…")).toBe(true);
  expect(titreY.texte.length).toBeGreaterThan(3);
  expect(textes.some(t => t.texte === "-150")).toBe(true);
  verifierTitresAxes(textes, "c-test-ellipse", titreY.texte, "temps (s)");
});
