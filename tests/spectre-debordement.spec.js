// Le trace du spectre en bande fine (echelle log en frequence) ne doit
// jamais deborder a gauche de son cadre de dessin (point 2). Le premier
// point du trace (proche de 0 Hz, avant passage au log) doit etre exclu ou
// ramene au bord plutot que de sortir du cadre.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererBruitBlanc, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

test("spectre en bande fine : aucun pixel de la courbe dans la marge gauche du cadre", async ({ page }) => {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-"));
  const wavPath = path.join(dir, "mesure.wav");
  const txtPath = path.join(dir, "mesure.txt");
  const { fs, canaux } = genererBruitBlanc({ niveauDbfsRms: -15, dureeS: 3, nCh: 4 });
  ecrireWavFichier(wavPath, fs, canaux);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([90,90,90,90]));

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await expect(page.locator("#btnAnalyser")).toBeEnabled();
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
  await page.locator("#c-spectre-0").waitFor();
  // laisse le rAF de dessin s'executer
  await page.waitForTimeout(200);

  const debordement = await page.evaluate(() => {
    const canvas = document.getElementById("c-spectre-0");
    const ctx = canvas.getContext("2d");
    // marge gauche du cadre (M.l = 52 CSS px) en pixels reels du canvas
    const dpr = window.devicePixelRatio || 1;
    const largeurMarge = Math.floor(50 * dpr);
    const img = ctx.getImageData(0, 0, largeurMarge, canvas.height);
    const [cr, cg, cb] = [0x0f, 0x4c, 0x5c]; // PALETTE_VOIES[0]
    let trouve = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i+1], b = img.data[i+2], a = img.data[i+3];
      if (a < 40) continue;
      const dist = Math.abs(r-cr) + Math.abs(g-cg) + Math.abs(b-cb);
      if (dist < 40) trouve++;
    }
    return trouve;
  });

  expect(debordement).toBe(0);
});
