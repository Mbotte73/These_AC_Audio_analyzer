// Le bouton Analyser doit rester desactive tant que tous les fichiers deposes
// (WAV et TXT d'etalonnage) n'ont pas ete lus : sinon un clic juste apres la
// lecture du WAV lancerait une analyse non etalonnee (niveaux en dBFS au lieu
// de dB SPL). Cause de l'echec intermittent de niveaux.spec.js.
//
// Determinisme : la lecture du TXT (fichierTxt.text() dans js/app.js) est
// retenue artificiellement en remplaçant Blob.prototype.text pour les
// fichiers .txt ; elle ne se termine que lorsque le test appelle
// window.__libererTxt() (ou echoue via window.__echouerTxt()).
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

const SPL_CONST = 100, NIVEAU_DBFS = -20, ATTENDU_SPL = SPL_CONST + NIVEAU_DBFS; // 80 dB SPL

async function ecrireMesure() {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-"));
  const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: NIVEAU_DBFS, dureeS: 2, nCh: 4 });
  const wavPath = path.join(dir, "mesure.wav");
  const txtPath = path.join(dir, "mesure.txt");
  ecrireWavFichier(wavPath, fs, canaux);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([SPL_CONST, SPL_CONST, SPL_CONST, SPL_CONST]));
  return { wavPath, txtPath };
}

async function retenirLectureTxt(page) {
  await page.evaluate(() => {
    const original = Blob.prototype.text;
    window.__txtDemande = false;
    Blob.prototype.text = function () {
      if (!(this instanceof File) || !/\.txt$/i.test(this.name)) return original.call(this);
      window.__txtDemande = true;
      return new Promise((resolve, reject) => {
        window.__libererTxt = () => original.call(this).then(resolve, reject);
        window.__echouerTxt = () => reject(new Error("lecture impossible (simulée)"));
      });
    };
  });
}

async function analyserEtLireOaspl(page) {
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
  const cellules = await page.locator("#zoneResultats table tbody tr").first().locator("td").allTextContents();
  return parseFloat(cellules[1]);
}

test("WAV + TXT en un seul dépôt, TXT lu en retard : bouton désactivé jusqu'à la fin de la lecture, analyse étalonnée", async ({ page }) => {
  const { wavPath, txtPath } = await ecrireMesure();
  await page.goto("/index.html");
  await retenirLectureTxt(page);

  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  // le WAV est lu et la lecture du TXT a commence, mais n'est pas terminee
  await expect(page.locator("#nomWav")).toHaveText(/mesure\.wav/);
  await page.waitForFunction(() => window.__txtDemande === true);
  await expect(page.locator("#btnAnalyser")).toBeDisabled();
  await expect(page.locator("#btnAnalyser")).toHaveText("Lecture des fichiers en cours…");
  await expect(page.locator("#nomTxt")).toHaveText("");

  await page.evaluate(() => window.__libererTxt());
  await expect(page.locator("#nomTxt")).toHaveText(/mesure\.txt/);
  await expect(page.locator("#btnAnalyser")).toBeEnabled();
  await expect(page.locator("#btnAnalyser")).toHaveText("Analyser (4 voies sélectionnées)");

  const oaspl = await analyserEtLireOaspl(page);
  expect(Math.abs(oaspl - ATTENDU_SPL)).toBeLessThan(0.2);
  await expect(page.locator("#zoneResultats .badge-cal.calibre")).not.toHaveCount(0);
  await expect(page.locator("#zoneResultats .badge-cal.non-calibre")).toHaveCount(0);
});

test("WAV puis TXT en deux dépôts, TXT lu en retard : le bouton redevient désactivé pendant la lecture du TXT", async ({ page }) => {
  const { wavPath, txtPath } = await ecrireMesure();
  await page.goto("/index.html");
  await retenirLectureTxt(page);

  await page.locator("#inputFichiers").setInputFiles([wavPath]);
  await expect(page.locator("#btnAnalyser")).toBeEnabled();

  await page.locator("#inputFichiers").setInputFiles([txtPath]);
  await page.waitForFunction(() => window.__txtDemande === true);
  await expect(page.locator("#btnAnalyser")).toBeDisabled();

  await page.evaluate(() => window.__libererTxt());
  await expect(page.locator("#btnAnalyser")).toBeEnabled();

  const oaspl = await analyserEtLireOaspl(page);
  expect(Math.abs(oaspl - ATTENDU_SPL)).toBeLessThan(0.2);
});

test("échec de lecture du TXT : erreur signalée, bouton réactivé, analyse possible mais non étalonnée", async ({ page }) => {
  const { wavPath, txtPath } = await ecrireMesure();
  await page.goto("/index.html");
  await retenirLectureTxt(page);
  const messages = [];
  page.on("dialog", d => { messages.push(d.message()); d.accept(); });

  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await page.waitForFunction(() => window.__txtDemande === true);
  await expect(page.locator("#btnAnalyser")).toBeDisabled();

  await page.evaluate(() => window.__echouerTxt());
  await expect(page.locator("#btnAnalyser")).toBeEnabled();
  expect(messages).toEqual(["Erreur de lecture du fichier TXT : lecture impossible (simulée)"]);
  await expect(page.locator("#statutAnalyse")).toHaveText("");

  const oaspl = await analyserEtLireOaspl(page);
  expect(Math.abs(oaspl - NIVEAU_DBFS)).toBeLessThan(0.2);
  await expect(page.locator("#zoneResultats .badge-cal.non-calibre")).not.toHaveCount(0);
  await expect(page.locator("#zoneResultats .badge-cal.calibre")).toHaveCount(0);
});
