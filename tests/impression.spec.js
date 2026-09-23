// Export PDF consolide (point 4) : l'impression par onglets ne montrait par
// defaut que l'onglet actuellement affiche, et un onglet jamais visite se
// serait imprime vide (canvas jamais dessine, 0x0). On verifie que
// l'evenement "beforeprint" (comme Ctrl+P ou window.print()) declenche le
// rendu complet des 4 voies, de la comparaison et de l'onglet capteur,
// meme sans les avoir ouverts au clavier/souris.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

test("beforeprint rend tous les onglets (jamais visites compris) avec des canvas non vides", async ({ page }) => {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-"));
  const wavPath = path.join(dir, "mesure.wav");
  const txtPath = path.join(dir, "mesure.txt");
  const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 2, nCh: 4 });
  ecrireWavFichier(wavPath, fs, canaux);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([100,100,100,100]));

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
  // seul l'onglet "voie0" a ete affiche : comparaison et capteur n'ont
  // jamais ete rendus a ce stade.

  const avant = await page.evaluate(() => document.getElementById("contenu-comparaison").children.length);
  expect(avant).toBe(0);

  const resultat = await page.evaluate(() => {
    window.dispatchEvent(new Event("beforeprint"));
    const ids = ["contenu-voie0","contenu-voie1","contenu-voie2","contenu-voie3","contenu-comparaison","contenu-capteur"];
    const tailles = {};
    let totalCanvas = 0, canvasVides = 0;
    for (const id of ids) {
      const div = document.getElementById(id);
      const canvases = div.querySelectorAll("canvas.chart");
      tailles[id] = canvases.length;
      for (const c of canvases) {
        totalCanvas++;
        if (c.width === 0 || c.height === 0) canvasVides++;
      }
    }
    return { tailles, totalCanvas, canvasVides };
  });

  expect(resultat.tailles["contenu-voie0"]).toBe(4);
  expect(resultat.tailles["contenu-voie1"]).toBe(4);
  expect(resultat.tailles["contenu-voie2"]).toBe(4);
  expect(resultat.tailles["contenu-voie3"]).toBe(4);
  expect(resultat.tailles["contenu-comparaison"]).toBe(1);
  expect(resultat.tailles["contenu-capteur"]).toBe(2);
  expect(resultat.totalCanvas).toBe(19);
  expect(resultat.canvasVides).toBe(0);

  // rendu vraiment synchrone : aucune trace visible a l'ecran apres coup
  const classeImpressionRestante = await page.evaluate(() => document.body.classList.contains("impression"));
  expect(classeImpressionRestante).toBe(false);
  await expect(page.locator("#contenu-voie1")).toBeHidden();

  // sous media print, tous les onglets doivent etre visibles
  await page.emulateMedia({ media: "print" });
  for (const id of ["contenu-voie0","contenu-voie1","contenu-voie2","contenu-voie3","contenu-comparaison","contenu-capteur"]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
});
