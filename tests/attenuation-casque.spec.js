// Tests de la vue "Atténuation d'un casque" : atténuation connue par pose,
// dérive de l'enceinte compensée par la référence, sensibilités différentes
// des deux micros sans effet, contrôle du bruit de fond, exports.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { ecrireWavFichier, construireCalibrationTxt } = require("./helpers/wav");

const FS = 16000, DUREE_S = 12;

function bruit(graine, rms) {
  let s = graine;
  const n = FS * DUREE_S, x = new Float64Array(n);
  // somme de 12 uniformes : quasi gaussien, variance 1
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let k = 0; k < 12; k++) { s = (s * 16807) % 2147483647; a += s / 2147483647; }
    x[i] = rms * (a - 6);
  }
  return x;
}
const gain = (x, g) => x.map(v => v * g);
const dB = (d) => Math.pow(10, d / 20);

// Voie 1 = micro sous le casque, 6 dB moins sensible que la voie 2 (référence).
// Avec casque, l'enceinte joue 3 dB plus fort (dérive) : la référence doit le compenser.
// Atténuations des poses : 20, 22 et 18 dB (moyenne 20, écart-type 2).
function preparerFichiers(dir, niveauFondRms) {
  const src = bruit(7, 0.1);
  const p = (nom) => path.join(dir, nom);
  ecrireWavFichier(p("sans.wav"), FS, [gain(src, 0.5), src]);
  const poses = [20, 22, 18].map((il, i) => {
    const f = p(`avec${i + 1}.wav`);
    ecrireWavFichier(f, FS, [gain(src, 0.5 * dB(3) / dB(il)), gain(src, dB(3))]);
    return f;
  });
  ecrireWavFichier(p("fond.wav"), FS, [bruit(11, niveauFondRms), bruit(13, niveauFondRms)]);
  fsNode.writeFileSync(p("cal.txt"), construireCalibrationTxt([110, 104]));
  return { sans: p("sans.wav"), poses, fond: p("fond.wav"), txt: p("cal.txt") };
}

async function ouvrir(page) {
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(e.message));
  await page.goto("/index.html");
  await page.locator('#modesNav button[data-mode="casque"]').click();
  await expect(page.locator("#vueTransport")).toBeHidden();
  await expect(page.locator("#vueCasque")).toBeVisible();
  return erreurs;
}

async function lireBandes(page) {
  return page.evaluate(() => casque.resultat.bandes.map(b => ({ fc: b.fc, il: b.il, sigma: b.sigma, min: b.ilMin, max: b.ilMax, statut: b.statut })));
}

test.describe("vue Atténuation d'un casque", () => {
  test("atténuation et dispersion connues, dérive de l'enceinte compensée", async ({ page }) => {
    const dir = fsNode.mkdtempSync(path.join(os.tmpdir(), "casque-"));
    const f = preparerFichiers(dir, 0.0005); // fond à -66 dBFS : toutes les bandes ok
    const erreurs = await ouvrir(page);

    await expect(page.locator("#casqueCalculer")).toBeDisabled();
    await page.locator("#casqueInput-sans").setInputFiles([f.sans, f.txt]);
    await page.locator("#casqueInput-avec").setInputFiles(f.poses);
    await page.locator("#casqueInput-fond").setInputFiles([f.fond]);
    await expect(page.locator("#casqueListe-avec li")).toHaveCount(3);
    await expect(page.locator("#casqueTxt")).toContainText("voies renseignées : 1, 2");
    await expect(page.locator("#casqueVoieMic")).toHaveValue("0");
    await expect(page.locator("#casqueVoieRef")).toHaveValue("1");

    await page.locator("#casqueCalculer").click();
    await expect(page.locator("#casqueResultats")).toBeVisible();

    const bandes = await lireBandes(page);
    // 20 Hz à 6,3 kHz : dernière bande dont le bord haut reste sous fs/2
    expect(bandes[0].fc).toBe(20);
    expect(bandes[bandes.length - 1].fc).toBe(6300);
    for (const b of bandes) {
      expect(b.statut).toBe("ok");
      expect(Math.abs(b.il - 20)).toBeLessThan(0.05);
      expect(Math.abs(b.sigma - 2)).toBeLessThan(0.05);
      expect(Math.abs(b.min - 18)).toBeLessThan(0.05);
      expect(Math.abs(b.max - 22)).toBeLessThan(0.05);
    }
    const r = await page.evaluate(() => ({ dLA: casque.resultat.dLA, minore: casque.resultat.dLAminore, uniteMic: casque.resultat.uniteMic }));
    expect(Math.abs(r.dLA - 20)).toBeLessThan(0.05);
    expect(r.minore).toBe(false);
    expect(r.uniteMic).toBe("dB SPL");

    // figures : spectres du micro et de la référence, atténuation, tableau
    for (const id of ["c-spectre-micro", "c-spectre-reference", "c-attenuation"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
      expect(await page.locator(`#${id}`).evaluate(c => c.width > 0)).toBe(true);
    }
    await expect(page.locator("#casqueTableau tbody tr")).toHaveCount(bandes.length);
    await expect(page.locator('#casqueTableau tr[data-fc="1000"] td').nth(4)).toHaveText("20,0");
    await expect(page.locator(".synthese-niveaux .valeur").first()).toHaveText("20,0 dB(A)");

    // export CSV : une colonne par pose
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#casqueCsv").click()]);
    const csv = fsNode.readFileSync(await dl.path(), "utf8");
    expect(csv).toContain("attenuation_pose3_dB");
    const ligne1k = csv.split("\n").find(l => l.startsWith("1000;"));
    expect(ligne1k).toMatch(/;20\.00;2\.00;20\.00;22\.00;18\.00;ok$/);

    // sans référence : la dérive de +3 dB de l'enceinte n'est plus compensée
    await page.locator("#casqueVoieRef").selectOption("-1");
    await page.locator("#casqueCalculer").click();
    const sansRef = await lireBandes(page);
    for (const b of sansRef) expect(Math.abs(b.il - 17)).toBeLessThan(0.05);
    await expect(page.locator("#c-spectre-reference")).toHaveCount(0);

    // retour aux mesures de transport
    await page.locator('#modesNav button[data-mode="transport"]').click();
    await expect(page.locator("#panelPresentation")).toBeVisible();
    await expect(page.locator("#vueCasque")).toBeHidden();
    expect(erreurs).toEqual([]);
  });

  test("bruit de fond trop proche : atténuation signalée comme minorée", async ({ page }) => {
    const dir = fsNode.mkdtempSync(path.join(os.tmpdir(), "casque-"));
    // micro avec casque vers -43 dBFS, fond à -48 dBFS : écart 5 dB < 10 dB
    const f = preparerFichiers(dir, 0.004);
    const erreurs = await ouvrir(page);
    await page.locator("#casqueInput-sans").setInputFiles([f.sans]);
    await page.locator("#casqueInput-avec").setInputFiles(f.poses);
    await page.locator("#casqueInput-fond").setInputFiles([f.fond]);
    await page.locator("#casqueCalculer").click();

    const bandes = await lireBandes(page);
    expect(bandes.every(b => b.statut === "minorée")).toBe(true);
    await expect(page.locator(".synthese-niveaux .valeur").first()).toHaveText(/^≥ 20,0 dB\(A\)$/);
    await expect(page.locator('#casqueTableau tr[data-fc="1000"] td').nth(4)).toHaveText("≥ 20,0");
    // pas de .TXT : spectres en dBFS
    expect(await page.evaluate(() => casque.resultat.uniteMic)).toBe("dBFS");
    expect(erreurs).toEqual([]);
  });

  test("erreurs de saisie : même voie, fréquences d'échantillonnage différentes", async ({ page }) => {
    const dir = fsNode.mkdtempSync(path.join(os.tmpdir(), "casque-"));
    const f = preparerFichiers(dir, 0.0005);
    const autre = path.join(dir, "autre_fs.wav");
    ecrireWavFichier(autre, 8000, [new Float64Array(8000 * 10), new Float64Array(8000 * 10)]);
    const erreurs = await ouvrir(page);
    await page.locator("#casqueInput-sans").setInputFiles([f.sans]);
    await page.locator("#casqueInput-avec").setInputFiles([f.poses[0]]);
    await page.locator("#casqueVoieRef").selectOption("0");
    await page.locator("#casqueCalculer").click();
    await expect(page.locator("#casqueResultats .avertissement")).toContainText("deux voies différentes");

    await page.locator("#casqueVoieRef").selectOption("1");
    await page.locator("#casqueInput-avec").setInputFiles([autre]);
    await page.locator("#casqueCalculer").click();
    await expect(page.locator("#casqueResultats .avertissement")).toContainText("Fréquences d'échantillonnage différentes");

    // retirer le fichier fautif rétablit le calcul (une seule pose : avertissement, pas d'erreur)
    await page.locator("#casqueListe-avec li").nth(1).locator("button").click();
    await page.locator("#casqueCalculer").click();
    await expect(page.locator("#c-attenuation")).toBeVisible();
    await expect(page.locator("#casqueResultats")).toContainText("1 pose seulement");
    expect(erreurs).toEqual([]);
  });
});
