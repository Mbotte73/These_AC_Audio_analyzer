// Cas d'usage reel le plus exigeant couvert par l'outil : jusqu'a 25 minutes
// d'enregistrement, 4 voies simultanees (cf. session "robustesse sur les
// longs enregistrements"). Complete fichier-long.spec.js (10 min) sans le
// dupliquer : verifie ici en plus (1) que le calcul reste exact a cette
// duree malgre le plafonnage du nombre de segments FFT calcules
// (parametresSegmentationFft, dsp.js) et (2) que la page reste reactive
// pendant le calcul (barre de progression qui avance reellement, pas figee),
// pas seulement que le resultat final est correct.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { construireCalibrationTxt, ecrireBruitBlancWavStream } = require("./helpers/wav");

const DUREE_S = 25 * 60;
const SPL_CONST = 90, NIVEAU_DBFS = -15, ATTENDU = SPL_CONST + NIVEAU_DBFS; // = 75.0 dB

test("fichier de 25 minutes, 4 voies : reactif pendant le calcul, niveaux et spectrogramme exacts sur la totalité", async ({ page }) => {
  test.setTimeout(300_000);

  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-tres-long-"));
  const wavPath = path.join(dir, "tres-long.wav");
  const txtPath = path.join(dir, "tres-long.txt");
  ecrireBruitBlancWavStream(wavPath, { dureeS: DUREE_S, nCh: 4, niveauDbfsRms: NIVEAU_DBFS });
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([SPL_CONST, SPL_CONST, SPL_CONST, SPL_CONST]));

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await expect(page.locator("#btnAnalyser")).toBeEnabled({ timeout: 60_000 });

  const debut = Date.now();
  await page.locator("#btnAnalyser").click();

  // Reactivite (point 2) : la barre de progression doit etre visible et
  // avancer par des valeurs distinctes pendant le calcul, pas rester figee a
  // 0 % jusqu'a la fin ni sauter directement a 100 % — preuve que la page se
  // redessine reellement pendant tout le traitement, pas seulement entre deux
  // blocs de plusieurs secondes.
  const valeursObservees = new Set();
  const finSondage = Date.now() + 60_000;
  while (Date.now() < finSondage) {
    const largeur = await page.evaluate(() => {
      const el = document.getElementById("barreProgressionRemplissage");
      return el ? el.style.width : null;
    }).catch(() => null);
    if (largeur) valeursObservees.add(largeur);
    if (valeursObservees.size >= 6) break;
    await page.waitForTimeout(250);
  }
  expect(valeursObservees.size).toBeGreaterThanOrEqual(4);
  console.log(`[fichier-tres-long] valeurs de progression distinctes observees en 60 s : ${valeursObservees.size} (${[...valeursObservees].join(", ")})`);

  await page.locator("#tabsNav button").first().waitFor({ timeout: 240_000 });
  const dureeAnalyseMs = Date.now() - debut;

  // La barre de progression doit disparaitre une fois l'analyse terminee.
  await expect(page.locator("#barreProgressionConteneur")).toBeHidden();

  const cellules = await page.locator("#zoneResultats table tbody tr").first().locator("td").allTextContents();
  const oaspl = parseFloat(cellules[1]);
  expect(Math.abs(oaspl - ATTENDU)).toBeLessThan(0.2);

  const t0 = Date.now();
  // Ouvre les 3 autres onglets (calcul paresseux du spectre/spectrogramme,
  // cf. activerOnglet dans app.js) : doit rester rapide grace au calcul
  // partage PSD/STFT et au plafonnage du nombre de segments (dsp.js).
  for (const idx of [1, 2, 3]) {
    await page.locator(`#tabsNav button[data-onglet="voie${idx}"]`).click();
    await expect(page.locator("#barreProgressionConteneur")).toBeHidden({ timeout: 60_000 });
  }
  const dureeAutresVoiesMs = Date.now() - t0;

  const resultat = await page.evaluate(() => {
    const psd = obtenirPsd(0);
    const stft = obtenirStft(0);
    let puissance = 0;
    for (let k = 0; k < psd.psdBrut.length; k++) puissance += psd.psdBrut[k] * psd.df;
    const niveauSpectre = 10 * Math.log10(Math.max(puissance, 1e-24) / (resultatsBase[0].pref * resultatsBase[0].pref));
    return {
      niveauSpectre,
      nColonnesSpectro: stft.trames.length,
      dernierTemps: stft.temps[stft.temps.length - 1],
      dureeFichierS: wavData.dureeS,
    };
  });

  expect(Math.abs(resultat.niveauSpectre - ATTENDU)).toBeLessThan(0.5);
  expect(resultat.nColonnesSpectro).toBeLessThanOrEqual(3000);
  expect(resultat.dernierTemps).toBeGreaterThan(resultat.dureeFichierS - 5);
  expect(resultat.dureeFichierS).toBeGreaterThan(DUREE_S - 1);

  console.log(`[fichier-tres-long] duree d'analyse (clic -> 1er onglet) : ${(dureeAnalyseMs/1000).toFixed(1)} s ; ` +
    `3 autres onglets : ${(dureeAutresVoiesMs/1000).toFixed(1)} s ; colonnes spectrogramme : ${resultat.nColonnesSpectro}`);
});
