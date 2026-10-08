// Onglet Comparaison, niveaux sonores : second graphique (LAeq court terme
// sur 1 s, une courbe par voie) et tableau des niveaux globaux, sous le
// spectre en bande fine. On verifie qu'ils obeissent aux memes cases a
// cocher que le spectre, que le tableau reprend exactement les valeurs des
// cartes de l'onglet Voie correspondant (aucun recalcul), et les cas
// limites : 1, 2 ou 4 voies, etalonnage mixte dB SPL / dBFS, voie signalee
// "niveau anormalement faible".
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

// Niveaux numeriques volontairement differents d'une voie a l'autre : des
// voies identiques donneraient des courbes exactement superposees, et une
// voie retiree resterait cachee sous les autres sans qu'on puisse le voir.
const NIVEAUX_DBFS = [-20, -26, -32, -38];

function canauxDecales(nCh, dureeS, niveaux = NIVEAUX_DBFS) {
  const { fs, canaux: base } = genererTonPur({ freqHz: 1000, niveauDbfsRms: 0, dureeS, nCh: 1 });
  const canaux = [];
  for (let c = 0; c < nCh; c++) {
    const gain = Math.pow(10, niveaux[c] / 20);
    canaux.push(base[0].map(x => x * gain));
  }
  return { fs, canaux };
}

async function chargerMesure(page, { canaux, fs, splParVoie, decocherAccueil = [] }) {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-comp-"));
  const wavPath = path.join(dir, "mesure.wav");
  const fichiers = [wavPath];
  ecrireWavFichier(wavPath, fs, canaux);
  if (splParVoie) {
    const txtPath = path.join(dir, "mesure.txt");
    fsNode.writeFileSync(txtPath, construireCalibrationTxt(splParVoie));
    fichiers.push(txtPath);
  }

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles(fichiers);
  await expect(page.locator("#btnAnalyser")).toBeEnabled();
  const cases = page.locator("#panelSelectionVoies .voie-select-carte");
  for (const i of decocherAccueil) await cases.nth(i).locator('input[type="checkbox"]').uncheck();
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
}

async function ouvrirComparaison(page) {
  await page.locator('#tabsNav button[data-onglet="comparaison"]').click();
  await expect(page.locator("#c-comparaison-niveaux")).toBeVisible();
}

// Nombre de pixels proches d'une couleur donnee (trait d'une voie, ou son
// segment de legende) dans un canvas : 0 si la voie n'y est pas tracee.
async function pixelsCouleur(page, idCanvas, hex) {
  return page.evaluate(([id, hex]) => {
    const c = document.getElementById(id);
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i+3] > 200 && Math.abs(d[i]-r) + Math.abs(d[i+1]-g) + Math.abs(d[i+2]-b) < 40) n++;
    }
    return n;
  }, [idCanvas, hex]);
}

async function lignesTableau(page) {
  return page.locator("#tableau-niveaux-comparaison tbody tr").evaluateAll(trs =>
    trs.map(tr => ({ voie: parseInt(tr.dataset.voie, 10), cellules: Array.from(tr.querySelectorAll("td")).map(td => td.textContent.trim()) })));
}

test.describe("onglet Comparaison : niveaux sonores", () => {
  test("4 voies : graphique de niveaux et tableau présents, décocher une voie la retire des deux graphiques et du tableau", async ({ page }) => {
    const { fs, canaux } = canauxDecales(4, 3);
    await chargerMesure(page, { canaux, fs, splParVoie: [100, 100, 100, 100] });
    await ouvrirComparaison(page);

    await expect(page.locator("#contenu-comparaison canvas.chart")).toHaveCount(2);
    await expect(page.locator("#tableau-niveaux-comparaison tbody tr")).toHaveCount(4);
    await expect(page.locator("#contenu-comparaison .btn-export")).toHaveCount(2);
    await expect(page.locator("#contenu-comparaison .avertissement-melange-unites")).toHaveCount(0);

    const couleurVoie2 = await page.evaluate(() => PALETTE_VOIES[1]);
    await expect.poll(() => pixelsCouleur(page, "c-comparaison-spectre", couleurVoie2)).toBeGreaterThan(0);
    await expect.poll(() => pixelsCouleur(page, "c-comparaison-niveaux", couleurVoie2)).toBeGreaterThan(0);

    await page.locator("#contenu-comparaison .cases-voies label").nth(1).locator("input").uncheck();

    await expect(page.locator("#tableau-niveaux-comparaison tbody tr")).toHaveCount(3);
    expect((await lignesTableau(page)).map(l => l.voie)).toEqual([0, 2, 3]);
    await expect.poll(() => pixelsCouleur(page, "c-comparaison-spectre", couleurVoie2)).toBe(0);
    await expect.poll(() => pixelsCouleur(page, "c-comparaison-niveaux", couleurVoie2)).toBe(0);
    // Les autres voies restent tracees sur le graphique de niveaux.
    const couleurVoie1 = await page.evaluate(() => PALETTE_VOIES[0]);
    expect(await pixelsCouleur(page, "c-comparaison-niveaux", couleurVoie1)).toBeGreaterThan(0);

    // La recocher la fait revenir partout.
    await page.locator("#contenu-comparaison .cases-voies label").nth(1).locator("input").check();
    await expect(page.locator("#tableau-niveaux-comparaison tbody tr")).toHaveCount(4);
    await expect.poll(() => pixelsCouleur(page, "c-comparaison-niveaux", couleurVoie2)).toBeGreaterThan(0);
  });

  test("valeurs du tableau identiques aux cartes de l'onglet Voie, unité propre à chaque voie (étalonnage mixte)", async ({ page }) => {
    const { fs, canaux } = canauxDecales(4, 3);
    await chargerMesure(page, { canaux, fs, splParVoie: [100, 100, null, null] });
    await ouvrirComparaison(page);

    // Etalonnage mixte : signale clairement dans l'onglet.
    const note = page.locator("#contenu-comparaison .avertissement-melange-unites");
    await expect(note).toBeVisible();
    await expect(note).toContainText("ne sont pas comparables");
    await expect(note).toContainText("Voie 1, Voie 2 en dB SPL");
    await expect(note).toContainText("Voie 3, Voie 4 en dBFS");

    const lignes = await lignesTableau(page);
    expect(lignes.map(l => l.voie)).toEqual([0, 1, 2, 3]);

    for (const { voie, cellules } of lignes) {
      await page.locator(`#tabsNav button[data-onglet="voie${voie}"]`).click();
      const cartes = page.locator(`#contenu-voie${voie} .synthese-niveaux .carte`);
      await expect(cartes).toHaveCount(5);
      const valeurs = await cartes.locator(".valeur").allTextContents();
      const labels = await cartes.locator(".label").allTextContents();
      // colonnes : Voie, OASPL, LAeq, LCeq, LCpeak, LAFmax, Unité
      expect(cellules.slice(1, 6)).toEqual(valeurs);
      const unite = cellules[6];
      expect(unite).toBe(voie < 2 ? "dB SPL" : "dBFS (non calibré)");
      for (const l of labels) expect(l).toContain(`(${unite})`);
    }

    // Plus de melange une fois les voies en dBFS decochees.
    await ouvrirComparaison(page);
    await page.locator("#contenu-comparaison .cases-voies label").nth(2).locator("input").uncheck();
    await page.locator("#contenu-comparaison .cases-voies label").nth(3).locator("input").uncheck();
    await expect(page.locator("#contenu-comparaison .avertissement-melange-unites")).toHaveCount(0);
    await expect(page.locator("#tableau-niveaux-comparaison tbody tr")).toHaveCount(2);
  });

  test("aucune voie cochée : même message que pour le spectre, dans le tableau", async ({ page }) => {
    const { fs, canaux } = canauxDecales(2, 2);
    await chargerMesure(page, { canaux, fs, splParVoie: [100, 100] });
    await ouvrirComparaison(page);
    await expect(page.locator("#tableau-niveaux-comparaison tbody tr")).toHaveCount(2);

    for (const i of [0, 1]) await page.locator("#contenu-comparaison .cases-voies label").nth(i).locator("input").uncheck();
    await expect(page.locator("#tableau-niveaux-comparaison table")).toHaveCount(0);
    await expect(page.locator("#tableau-niveaux-comparaison .note")).toHaveText("Sélectionnez au moins une voie ci-dessus.");
    await expect(page.locator("#contenu-comparaison canvas.chart")).toHaveCount(2);
    for (const hex of await page.evaluate(() => PALETTE_VOIES.slice(0, 2))) {
      await expect.poll(() => pixelsCouleur(page, "c-comparaison-niveaux", hex)).toBe(0);
    }
  });

  test("une seule voie analysée, puis deux : une ligne par voie analysée", async ({ page }) => {
    const { fs, canaux } = canauxDecales(4, 2);
    await chargerMesure(page, { canaux, fs, splParVoie: [100, 100, 100, 100], decocherAccueil: [0, 1, 3] });
    await ouvrirComparaison(page);
    expect((await lignesTableau(page)).map(l => l.voie)).toEqual([2]);
    await expect(page.locator("#contenu-comparaison .cases-voies label")).toHaveCount(1);
    const couleurVoie3 = await page.evaluate(() => PALETTE_VOIES[2]);
    await expect.poll(() => pixelsCouleur(page, "c-comparaison-niveaux", couleurVoie3)).toBeGreaterThan(0);

    const deux = canauxDecales(2, 2);
    await chargerMesure(page, { canaux: deux.canaux, fs: deux.fs, splParVoie: [100, 100] });
    await ouvrirComparaison(page);
    expect((await lignesTableau(page)).map(l => l.voie)).toEqual([0, 1]);
  });

  test("voie signalée « niveau anormalement faible » : reste affichée, avec badge et note", async ({ page }) => {
    // Voie 3 environ 60 dB sous les autres (micro debranche).
    const { fs, canaux } = canauxDecales(4, 2, [-20, -20, -80, -20]);
    await chargerMesure(page, { canaux, fs, splParVoie: [100, 100, 100, 100] });
    await ouvrirComparaison(page);

    const lignes = await lignesTableau(page);
    expect(lignes.map(l => l.voie)).toEqual([0, 1, 2, 3]);
    const ligneFaible = page.locator('#tableau-niveaux-comparaison tbody tr[data-voie="2"]');
    await expect(ligneFaible.locator(".badge-niveau-faible")).toBeVisible();
    await expect(page.locator('#tableau-niveaux-comparaison tbody tr[data-voie="0"] .badge-niveau-faible')).toHaveCount(0);
    await expect(page.locator("#tableau-niveaux-comparaison .note")).toContainText("Voie 3 a été signalée");
    const couleurVoie3 = await page.evaluate(() => PALETTE_VOIES[2]);
    await expect.poll(() => pixelsCouleur(page, "c-comparaison-niveaux", couleurVoie3)).toBeGreaterThan(0);
  });
});
