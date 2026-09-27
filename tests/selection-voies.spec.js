// Selection des voies a analyser, sur la page d'accueil (point B) : une case
// a cocher par voie reellement presente dans le fichier (wavData.nCh, pas une
// valeur fixe de 4), toutes cochees par defaut ; une voie decochee n'est pas
// seulement masquee, elle n'a aucune entree calculee (resultatsBase[v]
// n'existe pas) ; avertissement (jamais une decoche automatique) sur une voie
// dont le niveau est nettement plus faible que les autres voies cochees.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, ecrireWavFichier } = require("./helpers/wav");

function ecrireMesure(dir, canaux, fs) {
  const wavPath = path.join(dir, "mesure.wav");
  ecrireWavFichier(wavPath, fs, canaux);
  return wavPath;
}

test.describe("sélection des voies à analyser (point B)", () => {
  test("fichier à 2 voies : 2 cases affichées (pas 4), toutes cochées par défaut", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-sel-"));
    const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 1, nCh: 2 });
    const wavPath = ecrireMesure(dir, canaux, fs);

    await page.goto("/index.html");
    await page.locator("#inputFichiers").setInputFiles([wavPath]);
    await expect(page.locator("#panelSelectionVoies")).toBeVisible();

    const cases = page.locator("#panelSelectionVoies .voie-select-carte");
    await expect(cases).toHaveCount(2);
    await expect(cases.nth(0).locator('input[type="checkbox"]')).toBeChecked();
    await expect(cases.nth(1).locator('input[type="checkbox"]')).toBeChecked();
    await expect(page.locator("#btnAnalyser")).toHaveText("Analyser (2 voies sélectionnées)");
  });

  test("décocher une voie : elle n'apparaît pas dans les onglets, et n'a aucune entrée calculée", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-sel-"));
    const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 1, nCh: 4 });
    const wavPath = ecrireMesure(dir, canaux, fs);

    await page.goto("/index.html");
    await page.locator("#inputFichiers").setInputFiles([wavPath]);
    await expect(page.locator("#panelSelectionVoies")).toBeVisible();

    const cases = page.locator("#panelSelectionVoies .voie-select-carte");
    await cases.nth(2).locator('input[type="checkbox"]').uncheck(); // decoche Voie 3 (index 2)
    await expect(page.locator("#btnAnalyser")).toHaveText("Analyser (3 voies sélectionnées)");

    await page.locator("#btnAnalyser").click();
    await page.locator("#tabsNav button").first().waitFor();

    await expect(page.locator('#tabsNav button[data-onglet="voie2"]')).toHaveCount(0);
    await expect(page.locator('#tabsNav button[data-onglet="voie0"]')).toHaveCount(1);
    await expect(page.locator('#tabsNav button[data-onglet="voie3"]')).toHaveCount(1);

    // Le calcul est reellement saute pour la voie decochee (pas seulement
    // masque a l'affichage) : aucune entree resultatsBase pour l'index 2.
    const indicesAnalyses = await page.evaluate(() => {
      const arr = [];
      for (let v = 0; v < wavData.nCh; v++) if (resultatsBase[v]) arr.push(v);
      return arr;
    });
    expect(indicesAnalyses).toEqual([0, 1, 3]);

    const lignes = await page.locator("#zoneResultats table tbody tr").count();
    expect(lignes).toBe(3);
  });

  test("une seule voie cochée : le bouton reste actif, l'analyse fonctionne avec un seul onglet de voie", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-sel-"));
    const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 1, nCh: 4 });
    const wavPath = ecrireMesure(dir, canaux, fs);

    await page.goto("/index.html");
    await page.locator("#inputFichiers").setInputFiles([wavPath]);
    const cases = page.locator("#panelSelectionVoies .voie-select-carte");
    for (const i of [1, 2, 3]) await cases.nth(i).locator('input[type="checkbox"]').uncheck();
    await expect(page.locator("#btnAnalyser")).toHaveText("Analyser (1 voie sélectionnée)");
    await expect(page.locator("#btnAnalyser")).toBeEnabled();

    await page.locator("#btnAnalyser").click();
    await page.locator("#tabsNav button").first().waitFor();
    await expect(page.locator('#tabsNav button[data-onglet^="voie"]')).toHaveCount(1);
    await expect(page.locator('#tabsNav button[data-onglet="voie0"]')).toHaveCount(1);
  });

  test("toutes les voies décochées : le bouton Analyser est désactivé", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-sel-"));
    const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 1, nCh: 2 });
    const wavPath = ecrireMesure(dir, canaux, fs);

    await page.goto("/index.html");
    await page.locator("#inputFichiers").setInputFiles([wavPath]);
    const cases = page.locator("#panelSelectionVoies .voie-select-carte");
    await cases.nth(0).locator('input[type="checkbox"]').uncheck();
    await cases.nth(1).locator('input[type="checkbox"]').uncheck();
    await expect(page.locator("#btnAnalyser")).toBeDisabled();
    await expect(page.locator("#btnAnalyser")).toHaveText("Analyser");
  });

  test("voie anormalement faible : badge et message d'avertissement affichés, voie non décochée automatiquement", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-sel-"));
    const { fs, canaux: base } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 1, nCh: 1 });
    const canalNormal = base[0];
    const canalFaible = canalNormal.map(x => x * 0.001); // ~ -60 dB de moins : micro debranche/mal branche
    const canaux = [canalNormal, canalNormal, canalFaible, canalNormal];
    const wavPath = ecrireMesure(dir, canaux, fs);

    await page.goto("/index.html");
    await page.locator("#inputFichiers").setInputFiles([wavPath]);
    await expect(page.locator("#panelSelectionVoies")).toBeVisible();

    const carteFaible = page.locator("#panelSelectionVoies .voie-select-carte").nth(2);
    await expect(carteFaible).toHaveClass(/avertissement-carte/);
    await expect(carteFaible.locator(".badge-niveau-faible")).toBeVisible();
    await expect(carteFaible.locator('input[type="checkbox"]')).toBeChecked();
    await expect(page.locator("#panelSelectionVoies .avertissement")).toContainText("Voie 3");

    // Les autres voies, elles, ne portent pas l'avertissement.
    const carteNormale = page.locator("#panelSelectionVoies .voie-select-carte").nth(0);
    await expect(carteNormale).not.toHaveClass(/avertissement-carte/);
  });
});
