// Badge de statut de calibration sur chaque onglet de voie (point 6), sur
// un fichier a calibration mixte (voies 1-2 etalonnees, voies 3-4 non).
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

test("badge dB SPL / dBFS par voie, sur les onglets et dans le tableau de synthèse", async ({ page }) => {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-"));
  const wavPath = path.join(dir, "mesure.wav");
  const txtPath = path.join(dir, "mesure.txt");
  const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 2, nCh: 4 });
  ecrireWavFichier(wavPath, fs, canaux);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([100, 100, null, null]));

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();

  // Badges sur les onglets de voie.
  await expect(page.locator('#tabsNav button[data-onglet="voie0"] .badge-cal')).toHaveText("dB SPL");
  await expect(page.locator('#tabsNav button[data-onglet="voie0"] .badge-cal')).toHaveClass(/calibre/);
  await expect(page.locator('#tabsNav button[data-onglet="voie1"] .badge-cal')).toHaveText("dB SPL");
  await expect(page.locator('#tabsNav button[data-onglet="voie2"] .badge-cal')).toHaveText("dBFS");
  await expect(page.locator('#tabsNav button[data-onglet="voie2"] .badge-cal')).toHaveClass(/non-calibre/);
  await expect(page.locator('#tabsNav button[data-onglet="voie3"] .badge-cal')).toHaveText("dBFS");
  // Comparaison et capteur n'ont pas de badge.
  await expect(page.locator('#tabsNav button[data-onglet="comparaison"] .badge-cal')).toHaveCount(0);

  // Colonne "État" du tableau de synthèse.
  const etats = await page.locator("#zoneResultats table tbody tr .badge-cal").allTextContents();
  expect(etats).toEqual(["dB SPL", "dB SPL", "dBFS", "dBFS"]);

  // L'unité affichée dans les cartes d'un onglet de voie suit CETTE voie,
  // pas uniteCourante() (qui aurait affiché "dB SPL" pour toutes, a tort,
  // des qu'une seule voie du fichier est étalonnée).
  await page.locator('#tabsNav button[data-onglet="voie2"]').click();
  await expect(page.locator("#contenu-voie2 .synthese-niveaux .label").first()).toContainText("dBFS");
  await page.locator('#tabsNav button[data-onglet="voie0"]').click();
  await expect(page.locator("#contenu-voie0 .synthese-niveaux .label").first()).toContainText("dB SPL");
});
