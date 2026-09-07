// Tests de validation numerique (signaux de synthese a niveau connu),
// tolerance 0,2 dB, comme demande pour les deux endroits ou une erreur de
// calcul serait invisible a l'oeil sur l'interface : le spectrogramme
// (nouvelle fonction calculerStft) et la superposition brut/corrige de
// l'onglet "Parametres du capteur" (point 6). Les ajustements purement
// visuels (graduations, tailles, numerotation, boutons d'export,
// comparaison) ne sont pas re-verifies ici : un controle visuel suffit
// pour ceux-la.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, genererBruitBlanc, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

async function chargerMesure(page, { canaux, fs, splParVoie }) {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-"));
  const wavPath = path.join(dir, "mesure.wav");
  const txtPath = path.join(dir, "mesure.txt");
  ecrireWavFichier(wavPath, fs, canaux);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt(splParVoie));

  await page.goto("/index.html");
  await page.locator("#inputWav").setInputFiles(wavPath);
  await page.locator("#inputTxt").setInputFiles(txtPath);
  await expect(page.locator("#btnAnalyser")).toBeEnabled();
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
}

test("ton pur 1 kHz calibré : OASPL, LAeq, LCeq corrects à 0,2 dB près", async ({ page }) => {
  const SPL_CONST = 100, NIVEAU_DBFS = -20, ATTENDU = SPL_CONST + NIVEAU_DBFS; // = 80.0 dB
  const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: NIVEAU_DBFS, dureeS: 3, nCh: 4 });
  await chargerMesure(page, { canaux, fs, splParVoie: [SPL_CONST, SPL_CONST, SPL_CONST, SPL_CONST] });

  const cellules = await page.locator("#zoneResultats table tbody tr").first().locator("td").allTextContents();
  const [, oasplTxt, laeqTxt, lceqTxt] = cellules;
  expect(Math.abs(parseFloat(oasplTxt) - ATTENDU)).toBeLessThan(0.2);
  expect(Math.abs(parseFloat(laeqTxt) - ATTENDU)).toBeLessThan(0.2);
  expect(Math.abs(parseFloat(lceqTxt) - ATTENDU)).toBeLessThan(0.2);
});

test("spectrogramme (STFT) cohérent avec le spectre de Welch et le niveau théorique du ton", async ({ page }) => {
  const SPL_CONST = 100, NIVEAU_DBFS = -20, ATTENDU = SPL_CONST + NIVEAU_DBFS;
  const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: NIVEAU_DBFS, dureeS: 3, nCh: 4 });
  await chargerMesure(page, { canaux, fs, splParVoie: [SPL_CONST, SPL_CONST, SPL_CONST, SPL_CONST] });

  const res = await page.evaluate(() => {
    function niveauBandeAutour(freqs, valeurs, df, fCentre, largeurHz) {
      let somme = 0;
      for (let k = 0; k < freqs.length; k++) {
        if (Math.abs(freqs[k] - fCentre) <= largeurHz / 2) somme += valeurs[k] * df;
      }
      return 10 * Math.log10(Math.max(somme, 1e-24) / (PREF * PREF));
    }
    const psd = obtenirPsd(0);
    const stft = obtenirStft(0);
    const niveauWelch = niveauBandeAutour(Array.from(psd.freqs), Array.from(psd.psdBrut), psd.df, 1000, 200);

    const nBins = stft.freqs.length;
    const moy = new Float64Array(nBins);
    for (const trame of stft.trames) for (let k = 0; k < nBins; k++) moy[k] += trame[k] / stft.trames.length;
    const niveauStft = niveauBandeAutour(Array.from(stft.freqs), Array.from(moy), stft.df, 1000, 200);

    return { niveauWelch, niveauStft, nTrames: stft.trames.length };
  });

  expect(res.nTrames).toBeGreaterThan(1);
  expect(Math.abs(res.niveauWelch - ATTENDU)).toBeLessThan(0.2);
  expect(Math.abs(res.niveauStft - ATTENDU)).toBeLessThan(0.2);
  // les deux methodes partagent la meme formule par trame : elles doivent
  // quasiment coincider (verifie qu'on n'a pas introduit une divergence
  // d'echelle entre calculerPsd et calculerStft lors du refactor).
  expect(Math.abs(res.niveauWelch - res.niveauStft)).toBeLessThan(0.1);
});

test("correction de réponse du capteur : écart brut/corrigé conforme à la courbe micro à 20 kHz (point 6)", async ({ page }) => {
  const SPL_CONST = 100, NIVEAU_DBFS = -20;
  const { fs, canaux } = genererTonPur({ freqHz: 20000, niveauDbfsRms: NIVEAU_DBFS, dureeS: 3, nCh: 4 });
  await chargerMesure(page, { canaux, fs, splParVoie: [SPL_CONST, SPL_CONST, SPL_CONST, SPL_CONST] });

  const res = await page.evaluate(() => {
    const psd = obtenirPsd(0);
    const freqs = Array.from(psd.freqs);
    let idx = 0, meilleur = Infinity;
    for (let k = 0; k < freqs.length; k++) { const d = Math.abs(freqs[k] - 20000); if (d < meilleur) { meilleur = d; idx = k; } }
    const brutDb = 10 * Math.log10(Math.max(psd.psdBrut[idx], 1e-24) / (PREF * PREF));
    const corrDb = 10 * Math.log10(Math.max(psd.psdCorrige[idx], 1e-24) / (PREF * PREF));
    return { brutDb, corrDb, freq: freqs[idx], correctionAttendue: correctionMicroDb(freqs[idx]) };
  });

  // au-dessus de 5 kHz la courbe fabricant s'ecarte nettement de 0 dB : on
  // s'assure qu'on teste bien un ecart non trivial, pas un artefact nul.
  expect(res.correctionAttendue).toBeGreaterThan(5);
  const ecartMesure = res.brutDb - res.corrDb;
  expect(Math.abs(ecartMesure - res.correctionAttendue)).toBeLessThan(0.2);
});

test("bruit blanc calibré : OASPL correct à 0,2 dB près", async ({ page }) => {
  const SPL_CONST = 90, NIVEAU_DBFS = -15, ATTENDU = SPL_CONST + NIVEAU_DBFS; // = 75.0 dB
  const { fs, canaux } = genererBruitBlanc({ niveauDbfsRms: NIVEAU_DBFS, dureeS: 5, nCh: 4 });
  await chargerMesure(page, { canaux, fs, splParVoie: [SPL_CONST, SPL_CONST, SPL_CONST, SPL_CONST] });

  const cellules = await page.locator("#zoneResultats table tbody tr").first().locator("td").allTextContents();
  const oaspl = parseFloat(cellules[1]);
  expect(Math.abs(oaspl - ATTENDU)).toBeLessThan(0.2);
});
