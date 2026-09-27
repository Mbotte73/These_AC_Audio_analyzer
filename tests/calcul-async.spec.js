// Verifie que les variantes chunkees introduites pour rendre l'analyse
// reactive (session "robustesse sur les longs enregistrements") produisent
// un resultat strictement identique aux fonctions synchrones existantes :
// lfilterAsync (dsp.js) doit etre bit-identique a lfilter, et
// calculerSegmentsFftAsync doit produire le meme resultat que calculerPsd/
// calculerStft (et alimenter le meme cache partage). Aucun fichier WAV requis
// : calcul pur, directement dans la page.
const { test, expect } = require("@playwright/test");

test("lfilterAsync : bit-identique a lfilter sur un signal decoupe en plusieurs tranches", async ({ page }) => {
  await page.goto("/index.html");
  const resultat = await page.evaluate(async () => {
    const n = 1_500_000; // > TAILLE_TRANCHE_LFILTER : force plusieurs tranches
    const x = new Float64Array(n);
    let etat = 7;
    function alea() { etat = (etat * 1664525 + 1013904223) >>> 0; return (etat / 4294967296) * 2 - 1; }
    for (let i = 0; i < n; i++) x[i] = alea();

    const yRef = lfilter(B_A, A_A, x);
    let appelsProgres = 0, dernierProgres = 0;
    const yAsync = await lfilterAsync(B_A, A_A, x, (p) => { appelsProgres++; dernierProgres = p; }, () => Promise.resolve());

    let maxDiff = 0;
    for (let i = 0; i < n; i++) { const d = Math.abs(yRef[i] - yAsync[i]); if (d > maxDiff) maxDiff = d; }
    return { maxDiff, appelsProgres, dernierProgres };
  });

  expect(resultat.maxDiff).toBe(0);
  expect(resultat.appelsProgres).toBeGreaterThan(1);
  expect(resultat.dernierProgres).toBe(1);
});

test("calculerSegmentsFftAsync : meme resultat que calculerPsd/calculerStft, cache partage", async ({ page }) => {
  await page.goto("/index.html");
  const resultat = await page.evaluate(async () => {
    const fs = 44100, dureeS = 5, n = fs * dureeS;
    const signal = new Float32Array(n);
    for (let i = 0; i < n; i++) signal[i] = Math.sin(2*Math.PI*1000*i/fs) * 0.5;
    const params = parametresFftParDefaut(fs, n);

    // Chemin async d'abord (comme le fait l'analyse reelle pour la premiere
    // voie affichee) : calculerPsd/calculerStft doivent ensuite retrouver le
    // resultat deja calcule dans le cache partage, sans le recalculer.
    const rAsync = await calculerSegmentsFftAsync(signal, fs, params, () => {}, () => Promise.resolve());
    const psdSync = calculerPsd(signal, fs, params);
    const stftSync = calculerStft(signal, fs, params);

    let diffPsd = 0;
    for (let k = 0; k < psdSync.psd.length; k++) diffPsd = Math.max(diffPsd, Math.abs(psdSync.psd[k]-rAsync.psd[k]));

    return {
      diffPsd,
      memeNbTrames: stftSync.trames.length === rAsync.trames.length,
      nTrames: stftSync.trames.length,
    };
  });

  expect(resultat.diffPsd).toBe(0);
  expect(resultat.memeNbTrames).toBe(true);
  expect(resultat.nTrames).toBeGreaterThan(0);
});

test("parametresSegmentationFft : plafonne le nombre de segments calcules sur un tres long fichier, sans depasser nperseg pour le pas", async ({ page }) => {
  await page.goto("/index.html");
  const resultat = await page.evaluate(() => {
    const fs = 44100;
    const params = { nperseg: 32768, recouvrement: 50, fenetre: "hann" };

    const long25min = 25*60*fs;
    const seg25 = parametresSegmentationFft(long25min, params);
    const nSeg25 = Math.floor((long25min - seg25.nperseg) / seg25.step) + 1;

    const long10min = 10*60*fs;
    const seg10 = parametresSegmentationFft(long10min, params);
    const stepAttendu10 = Math.max(1, Math.round(params.nperseg * (1 - params.recouvrement/100)));

    return { nSeg25, step25: seg25.step, nperseg25: seg25.nperseg, step10: seg10.step, stepAttendu10 };
  });

  expect(resultat.nSeg25).toBeLessThanOrEqual(3000 * 1.05);
  expect(resultat.step25).toBeLessThanOrEqual(resultat.nperseg25);
  // Sous le seuil (10 min), le comportement historique (pas derive uniquement
  // du recouvrement choisi) reste inchange.
  expect(resultat.step10).toBe(resultat.stepAttendu10);
});
