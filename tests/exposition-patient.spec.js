// Tests de l'onglet "Exposition patient" : ponderations ISO 2631-1 contre les
// valeurs tabulees de la norme, attenuation de bruit connue entre deux voies,
// transmissibilite connue entre deux telephones, confort et chocs.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

const FS_AUDIO = 8000, DUREE_S = 120, FS_ACC = 400;

function alea(graine) {
  let s = graine;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
}

// Voie 1 = exterieur (bruit), voie 2 = interieur = exterieur / 10 (-20 dB
// dans toutes les bandes), les deux etalonnees a 100 dB SPL pleine echelle.
async function chargerMesure(page, dir) {
  const n = DUREE_S * FS_AUDIO, ext = new Float64Array(n), int = new Float64Array(n);
  const r = alea(7);
  for (let i = 0; i < n; i++) { ext[i] = 0.3 * r(); int[i] = ext[i] / 10; }
  const wavPath = path.join(dir, "mesure.wav"), txtPath = path.join(dir, "mesure.txt");
  ecrireWavFichier(wavPath, FS_AUDIO, [ext, int]);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([100, 100]));
  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
}

// Telephone 1 = plancher (bruit blanc sur 3 axes, plus un choc vertical a
// 60 s), telephone 2 = support = 2 x plancher : transmissibilite +6,02 dB.
function csvAccel(gain) {
  const r = alea(11);
  const lignes = ['"Time (s)","Linear Acceleration x (m/s^2)","Linear Acceleration y (m/s^2)","Linear Acceleration z (m/s^2)"'];
  for (let i = 0; i < DUREE_S * FS_ACC; i++) {
    const t = i / FS_ACC;
    let z = r();
    if (i >= 60 * FS_ACC && i < 60 * FS_ACC + 8) z += 12;
    lignes.push(`${t.toFixed(5)},${(gain * r()).toFixed(5)},${(gain * r()).toFixed(5)},${(gain * z).toFixed(5)}`);
  }
  return lignes.join("\n");
}

async function deposerAccels(page, dir) {
  await page.locator('#tabsNav button[data-onglet="vol"]').click();
  for (const [k, gain] of [[1, 1], [2, 2]]) {
    const p = path.join(dir, `accel${k}.csv`);
    fsNode.writeFileSync(p, csvAccel(gain));
    const depot = page.locator("#contenu-vol .vol-depot").nth(k);
    await depot.locator('input[type="file"]').setInputFiles(p);
    await expect(depot.locator(".filename")).toContainText(`accel${k}.csv`);
  }
}

test.describe("onglet Exposition patient", () => {
  test("ponderations Wk et Wd conformes aux valeurs tabulees d'ISO 2631-1", async ({ page }) => {
    await page.goto("/index.html");
    const valeurs = await page.evaluate(() => ({
      wk: [0.5, 1, 2, 4, 6.3, 8, 16, 31.5, 80].map(f => patModulePonderation(f, PAT_WK)),
      wd: [1, 2, 4, 8, 16].map(f => patModulePonderation(f, PAT_WD)),
    }));
    const wk = [0.418, 0.482, 0.531, 0.967, 1.054, 1.036, 0.768, 0.405, 0.132];
    const wd = [1.011, 0.890, 0.512, 0.253, 0.125];
    valeurs.wk.forEach((v, i) => expect(Math.abs(v - wk[i])).toBeLessThan(0.003));
    valeurs.wd.forEach((v, i) => expect(Math.abs(v - wd[i])).toBeLessThan(0.003));
  });

  test("attenuation de 20 dB, transmissibilite de +6 dB, choc detecte", async ({ page }) => {
    test.setTimeout(120_000);
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-patient-"));
    await chargerMesure(page, dir);
    await deposerAccels(page, dir);

    await page.locator('#tabsNav button[data-onglet="patient"]').click();
    const selects = page.locator("#contenu-patient .pat-grille select");
    await selects.nth(0).selectOption("1");   // micro interieur = voie 2
    await selects.nth(1).selectOption("0");   // micro exterieur = voie 1
    await selects.nth(2).selectOption("1");   // support = telephone 2
    await selects.nth(4).selectOption("0");   // plancher = telephone 1
    await page.locator("#btnCalculPatient").click();
    await expect(page.locator("#contenu-patient .pat-section")).toHaveCount(3, { timeout: 60_000 });

    // Bruit : ecart LAeq de 20 dB, et 20 dB dans chaque tiers d'octave.
    await expect(page.locator("#contenu-patient .pat-table").first()).toContainText("20,0 dB");
    const att = await page.evaluate(() => patResultats.bruit.bandesValides.map(b => patResultats.bruit.ext.bandes[b.k] - patResultats.bruit.int.bandes[b.k]));
    expect(att.length).toBeGreaterThan(10);
    for (const a of att) expect(Math.abs(a - 20)).toBeLessThan(0.05);

    // Vibrations : transmissibilite moyenne de 20 log10(2) = 6,02 dB.
    const t = await page.evaluate(() => {
      const tr = patResultats.transmission; let s = 0, n = 0;
      for (let k = 0; k < tr.freqs.length; k++) if (tr.freqs[k] >= 2 && tr.freqs[k] <= tr.fHaut) { s += 10 * Math.log10(tr.somme.sup[k] / tr.somme.pla[k]); n++; }
      return s / n;
    });
    expect(Math.abs(t - 6.02)).toBeLessThan(0.05);
    await expect(page.locator("#c-pat-transmissibilite")).toBeVisible();
    await expect(page.locator("#c-pat-confort")).toBeVisible();

    // Confort : a_v du support = 2 x a_v du plancher (meme signal, gain 2).
    const ratio = await page.evaluate(() => patResultats.support.av / patResultats.plancher.av);
    expect(Math.abs(ratio - 2)).toBeLessThan(0.01);

    // Chocs : l'impulsion verticale a 60 s est le seul evenement au seuil par defaut.
    const chocs = page.locator("#contenu-patient .pat-chocs");
    await expect(chocs).toContainText("1 événement");
    await expect(chocs.locator("tbody tr").first()).toContainText("1 min 00 s");
  });

  test("sans telephone : message et renvoi vers l'onglet Trajet", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-patient2-"));
    await chargerMesure(page, dir);
    await page.locator('#tabsNav button[data-onglet="patient"]').click();
    await expect(page.locator("#contenu-patient")).toContainText("Aucun export accéléromètre chargé");
    await page.locator("#contenu-patient button", { hasText: "Aller à l'onglet Trajet" }).click();
    await expect(page.locator('#tabsNav button[data-onglet="vol"]')).toHaveClass(/actif/);
  });
});
