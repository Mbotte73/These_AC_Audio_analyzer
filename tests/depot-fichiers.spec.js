// Tests de la zone de depot unique WAV + TXT (point 1) : depot groupe,
// depot en deux gestes separes, et avertissement quand les noms de base
// des deux fichiers ne correspondent pas (le WAV doit quand meme se charger).
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

function ecrireMesure(dir, { nomWav, nomTxt, splParVoie }) {
  const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 2, nCh: 4 });
  const wavPath = path.join(dir, nomWav);
  const txtPath = path.join(dir, nomTxt);
  ecrireWavFichier(wavPath, fs, canaux);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt(splParVoie));
  return { wavPath, txtPath };
}

test("depot groupe (WAV + TXT en un seul geste) : analyse calibree", async ({ page }) => {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-"));
  const { wavPath, txtPath } = ecrireMesure(dir, { nomWav: "mesure.wav", nomTxt: "mesure.txt", splParVoie: [100,100,100,100] });

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await expect(page.locator("#nomWav")).toHaveText(/mesure\.wav/);
  await expect(page.locator("#nomTxt")).toHaveText(/mesure\.txt/);
  await expect(page.locator("#avertDepot")).toBeHidden();
  await expect(page.locator("#btnAnalyser")).toBeEnabled();
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();

  const cellules = await page.locator("#zoneResultats table tbody tr").first().locator("td").allTextContents();
  expect(Math.abs(parseFloat(cellules[1]) - 80)).toBeLessThan(0.2);
});

test("depot en deux gestes separes (WAV puis TXT) : analyse calibree malgre tout", async ({ page }) => {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-"));
  const { wavPath, txtPath } = ecrireMesure(dir, { nomWav: "mesure.wav", nomTxt: "mesure.txt", splParVoie: [100,100,100,100] });

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath]);
  await expect(page.locator("#btnAnalyser")).toBeEnabled();
  await page.locator("#inputFichiers").setInputFiles([txtPath]);
  await expect(page.locator("#nomTxt")).toHaveText(/mesure\.txt/);

  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
  const cellules = await page.locator("#zoneResultats table tbody tr").first().locator("td").allTextContents();
  expect(Math.abs(parseFloat(cellules[1]) - 80)).toBeLessThan(0.2);
});

test("noms de fichiers differents : avertissement affiche, WAV charge quand meme", async ({ page }) => {
  const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-"));
  const { wavPath, txtPath } = ecrireMesure(dir, { nomWav: "campagne_voieA.wav", nomTxt: "etalonnage_2026.txt", splParVoie: [100,100,100,100] });

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await expect(page.locator("#avertDepot")).toBeVisible();
  await expect(page.locator("#avertDepot")).toContainText("ne correspondent pas");
  await expect(page.locator("#btnAnalyser")).toBeEnabled();

  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
  const cellules = await page.locator("#zoneResultats table tbody tr").first().locator("td").allTextContents();
  expect(Math.abs(parseFloat(cellules[1]) - 80)).toBeLessThan(0.2);
});
