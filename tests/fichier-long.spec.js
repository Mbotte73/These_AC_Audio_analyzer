// Performances sur un fichier long (point 5). Une vraie campagne de mesure
// produit des fichiers de plusieurs minutes ; les autres tests ne portent
// que sur quelques secondes de synthese. Ici, 10 minutes de bruit blanc
// calibre (4 voies, 16 bits, 44100 Hz = ~212 Mo) : on verifie que
// l'analyse reste exacte sur la totalite du fichier (OASPL, spectre en
// bande fine) et que le spectrogramme reste borne en nombre de colonnes
// affichees, sans qu'aucune portion du signal ne soit sautee (regroupement
// par moyenne, pas d'elargissement du pas — cf. dsp.js calculerStft).
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { construireCalibrationTxt, ecrireBruitBlancWavStream } = require("./helpers/wav");

const DUREE_S = 600;
const SPL_CONST = 90, NIVEAU_DBFS = -15, ATTENDU = SPL_CONST + NIVEAU_DBFS; // = 75.0 dB

test("fichier de 10 minutes : chargement et analyse sans blocage, niveaux et spectrogramme exacts sur la totalité", async ({ page }) => {
  test.setTimeout(240_000);

  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-long-"));
  const wavPath = path.join(dir, "long.wav");
  const txtPath = path.join(dir, "long.txt");
  ecrireBruitBlancWavStream(wavPath, { dureeS: DUREE_S, nCh: 4, niveauDbfsRms: NIVEAU_DBFS });
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([SPL_CONST, SPL_CONST, SPL_CONST, SPL_CONST]));

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await expect(page.locator("#btnAnalyser")).toBeEnabled({ timeout: 60_000 });

  const debut = Date.now();
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor({ timeout: 180_000 });
  const dureeAnalyseMs = Date.now() - debut;

  // OASPL exact sur la totalite du fichier (le passe-haut 20 Hz n'affecte
  // pas un bruit blanc large bande de facon perceptible ici).
  const cellules = await page.locator("#zoneResultats table tbody tr").first().locator("td").allTextContents();
  const oaspl = parseFloat(cellules[1]);
  expect(Math.abs(oaspl - ATTENDU)).toBeLessThan(0.2);

  const resultat = await page.evaluate(() => {
    const psd = obtenirPsd(0);
    const stft = obtenirStft(0);

    // Parseval : la puissance integree sur le spectre en bande fine doit
    // redonner le meme niveau global que le calcul temporel (OASPL),
    // preuve que le spectre couvre bien la totalite du fichier, pas
    // seulement un extrait.
    let puissance = 0;
    for (let k = 0; k < psd.psdBrut.length; k++) puissance += psd.psdBrut[k] * psd.df;
    const niveauSpectre = 10 * Math.log10(Math.max(puissance, 1e-24) / (resultatsBase[0].pref * resultatsBase[0].pref));

    return {
      niveauSpectre,
      nColonnesSpectro: stft.trames.length,
      tramesGroupees: stft.tramesGroupees,
      dernierTemps: stft.temps[stft.temps.length - 1],
      dureeFichierS: wavData.dureeS,
    };
  });

  expect(Math.abs(resultat.niveauSpectre - ATTENDU)).toBeLessThan(0.5);
  expect(resultat.nColonnesSpectro).toBeLessThanOrEqual(3000);
  // le spectrogramme regroupe des trames par moyenne au lieu de sauter des
  // portions du signal : sa derniere colonne doit donc bien representer la
  // fin du fichier, pas seulement les toutes premieres minutes.
  expect(resultat.dernierTemps).toBeGreaterThan(resultat.dureeFichierS - 5);
  expect(resultat.dureeFichierS).toBeGreaterThan(DUREE_S - 1);

  console.log(`[fichier-long] duree d'analyse (clic -> onglets prets) : ${(dureeAnalyseMs/1000).toFixed(1)} s, colonnes spectrogramme : ${resultat.nColonnesSpectro} (regroupement x${resultat.tramesGroupees || 1})`);
});
