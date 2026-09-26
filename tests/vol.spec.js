// Tests de l'onglet "Vol" (import phyphox, recalage, LAeq court terme).
// Comme demande, la logique testable sans fichiers reels (parsing CSV
// phyphox synthetique, calcul de magnitude accelerometre, calcul de LAeq
// court terme compare a une valeur theorique, extraction d'horodatage) est
// verifiee directement via page.evaluate, sans dependre d'un vrai export
// phyphox (aucun exemple reel n'a ete fourni pour cette session, cf. resume
// final). Deux tests d'integration verifient en plus le depot de fichiers
// CSV synthetiques dans l'interface de l'onglet.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { genererTonPur, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

test.describe("phyphox.js — parsing pur (sans fichier)", () => {
  test("parserGpsPhyphox : en-tetes anglaises, virgule", async ({ page }) => {
    await page.goto("/index.html");
    const csv = [
      "Time (s),Latitude (°),Longitude (°),Height (m),Horizontal Accuracy (m)",
      "0,45.000,5.000,1000,3",
      "1,45.001,5.001,1010,3",
      "2,45.002,5.002,1020,3",
    ].join("\n");
    const res = await page.evaluate((texte) => {
      const r = parserGpsPhyphox(texte);
      return { temps: r.temps, lat: r.lat, lon: r.lon, alt: r.alt, altitudeDisponible: r.altitudeDisponible };
    }, csv);
    expect(res.altitudeDisponible).toBe(true);
    expect(res.temps).toEqual([0,1,2]);
    expect(res.lat[1]).toBeCloseTo(45.001, 5);
    expect(res.lon[2]).toBeCloseTo(5.002, 5);
    expect(res.alt).toEqual([1000,1010,1020]);
  });

  test("parserGpsPhyphox : en-tetes francaises, separateur point-virgule et decimale virgule", async ({ page }) => {
    await page.goto("/index.html");
    const csv = [
      "Temps (s);Latitude (°);Longitude (°);Hauteur (m);Précision horizontale (m)",
      "0,0;45,000;5,000;1000,0;3,0",
      "1,0;45,001;5,001;1010,0;3,0",
    ].join("\n");
    const res = await page.evaluate((texte) => parserGpsPhyphox(texte), csv);
    expect(res.temps).toEqual([0,1]);
    expect(res.lat[1]).toBeCloseTo(45.001, 5);
    expect(res.alt[1]).toBeCloseTo(1010.0, 5);
  });

  test("parserGpsPhyphox : fichier non reconnu (colonnes latitude/longitude absentes) leve une erreur claire", async ({ page }) => {
    await page.goto("/index.html");
    const csv = ["Time (s),Pressure (hPa)", "0,1013.2", "1,1013.1"].join("\n");
    const message = await page.evaluate((texte) => {
      try { parserGpsPhyphox(texte); return null; } catch (err) { return err.message; }
    }, csv);
    expect(message).not.toBeNull();
    expect(message.toLowerCase()).toContain("gps");
  });

  test("parserAccelPhyphox : magnitude calculee depuis x/y/z connus", async ({ page }) => {
    await page.goto("/index.html");
    const csv = [
      "Time (s),Linear Acceleration x (m/s^2),Linear Acceleration y (m/s^2),Linear Acceleration z (m/s^2)",
      "0,3,4,0",
      "1,1,2,2",
    ].join("\n");
    const res = await page.evaluate((texte) => parserAccelPhyphox(texte), csv);
    expect(res.parAxes).toBe(true);
    expect(res.magnitude[0]).toBeCloseTo(5, 6);        // 3-4-5
    expect(res.magnitude[1]).toBeCloseTo(3, 6);        // sqrt(1+4+4) = 3
  });

  test("parserAccelPhyphox : fichier non reconnu (aucune colonne d'acceleration) leve une erreur claire", async ({ page }) => {
    await page.goto("/index.html");
    const csv = ["Time (s),Pressure (hPa)", "0,1013.2"].join("\n");
    const message = await page.evaluate((texte) => {
      try { parserAccelPhyphox(texte); return null; } catch (err) { return err.message; }
    }, csv);
    expect(message).not.toBeNull();
    expect(message.toLowerCase()).toContain("acceleration");
  });

  test("magnitude3 : cas connus", async ({ page }) => {
    await page.goto("/index.html");
    const res = await page.evaluate(() => [magnitude3(3,4,0), magnitude3(0,0,0), magnitude3(1,2,2)]);
    expect(res[0]).toBeCloseTo(5, 9);
    expect(res[1]).toBeCloseTo(0, 9);
    expect(res[2]).toBeCloseTo(3, 9);
  });
});

test.describe("vol.js — horodatage et LAeq court terme (sans fichier)", () => {
  test("extraireHorodatageTxt : ligne presente vs \"NON DISPONIBLE\"", async ({ page }) => {
    await page.goto("/index.html");
    const res = await page.evaluate(() => {
      const d1 = extraireHorodatageTxt("Date et heure : 2026-09-20 14:30:05\nautre ligne");
      const d2 = extraireHorodatageTxt("Date et heure : NON DISPONIBLE, horloge non synchronisee");
      return {
        d1: d1 ? [d1.getFullYear(), d1.getMonth(), d1.getDate(), d1.getHours(), d1.getMinutes(), d1.getSeconds()] : null,
        d2,
      };
    });
    expect(res.d1).toEqual([2026, 8, 20, 14, 30, 5]);
    expect(res.d2).toBeNull();
  });

  test("LAeq court terme (fenetre 1 s, ponderee A) : ton 1 kHz calibre conforme a la valeur theorique a 0,2 dB pres", async ({ page }) => {
    await page.goto("/index.html");
    const SPL_CONST = 100, NIVEAU_DBFS = -20, ATTENDU = SPL_CONST + NIVEAU_DBFS; // 80.0 dB, A ~ 0 dB a 1 kHz
    const res = await page.evaluate(({ splConst, niveauDbfs }) => {
      const fs = 44100, dureeS = 3, freq = 1000;
      const n = Math.round(dureeS * fs);
      const amplitude = Math.pow(10, niveauDbfs / 20) * Math.SQRT2;
      const gain = PREF * Math.pow(10, splConst / 20);
      const pression = new Float64Array(n);
      for (let i = 0; i < n; i++) pression[i] = amplitude * Math.sin(2 * Math.PI * freq * i / fs) * gain;
      const pressionHp = lfilter(B_HP20, A_HP20, pression);
      const sigA = lfilter(B_A, A_A, pressionHp);
      const t = niveauTemporel(sigA, fs, PREF, 1.0);
      return { temps: t.temps, niveaux: t.niveaux };
    }, { splConst: SPL_CONST, niveauDbfs: NIVEAU_DBFS });

    expect(res.niveaux.length).toBe(3); // 3 fenetres de 1 s sur 3 s de signal
    for (const v of res.niveaux) expect(Math.abs(v - ATTENDU)).toBeLessThan(0.2);
  });
});

test.describe("onglet Vol — integration avec fichiers CSV synthetiques", () => {
  async function chargerMesureAvecHorodatage(page, dir) {
    const wavPath = path.join(dir, "mesure.wav");
    const txtPath = path.join(dir, "mesure.txt");
    const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 2, nCh: 4 });
    ecrireWavFichier(wavPath, fs, canaux);
    const txt = construireCalibrationTxt([100,100,100,100]) + "\nDate et heure : 2026-09-20 14:30:00\n";
    fsNode.writeFileSync(txtPath, txt);

    await page.goto("/index.html");
    await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
    await expect(page.locator("#btnAnalyser")).toBeEnabled();
    await page.locator("#btnAnalyser").click();
    await page.locator("#tabsNav button").first().waitFor();
    await page.locator('#tabsNav button[data-onglet="vol"]').click();
  }

  test("depot GPS + accelerometre phyphox synthetiques : titre horodate, decalage manuel, graphiques non vides, export KML", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-"));
    await chargerMesureAvecHorodatage(page, dir);

    await expect(page.locator("#contenu-vol h3")).toContainText("Vol du 20/09/2026");

    const gpsCsv = [
      "Time (s),Latitude (°),Longitude (°),Height (m)",
      "0,45.000,5.000,1000",
      "1,45.001,5.001,1010",
      "2,45.002,5.002,1005",
    ].join("\n");
    const gpsPath = path.join(dir, "gps.csv");
    fsNode.writeFileSync(gpsPath, gpsCsv);

    const accelCsv = [
      "Time (s),Linear Acceleration x (m/s^2),Linear Acceleration y (m/s^2),Linear Acceleration z (m/s^2)",
      "0,3,4,0",
      "1,1,2,2",
      "2,0,0,1",
    ].join("\n");
    const accelPath = path.join(dir, "accel1.csv");
    fsNode.writeFileSync(accelPath, accelCsv);

    const depots = page.locator("#contenu-vol .vol-depot");
    await depots.nth(0).locator('input[type="file"]').setInputFiles(gpsPath);
    await expect(depots.nth(0).locator(".avertissement")).toBeHidden();
    await depots.nth(1).locator('input[type="file"]').setInputFiles(accelPath);
    await expect(depots.nth(1).locator(".avertissement")).toBeHidden();

    // reglage manuel du decalage (filet de securite demande, independant de
    // toute detection automatique d'horodatage absolu)
    const decalageGps = depots.nth(0).locator(".vol-decalage input");
    await decalageGps.fill("1.5");
    await decalageGps.dispatchEvent("input");

    const tailles = await page.evaluate(() => {
      const ids = ["c-vol-altitude", "c-vol-son", "c-vol-accel"];
      const r = {};
      for (const id of ids) { const c = document.getElementById(id); r[id] = { w: c.width, h: c.height }; }
      return r;
    });
    for (const id of ["c-vol-altitude", "c-vol-son", "c-vol-accel"]) {
      expect(tailles[id].w).toBeGreaterThan(0);
      expect(tailles[id].h).toBeGreaterThan(0);
    }

    const telechargement = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter la trajectoire en KML" }).click();
    const download = await telechargement;
    expect(download.suggestedFilename()).toMatch(/\.kml$/);
  });

  test("depot d'un CSV non reconnu comme export GPS : message d'erreur affiche (pas de plantage silencieux)", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-"));
    await chargerMesureAvecHorodatage(page, dir);

    const mauvaisCsv = ["Time (s),Pressure (hPa)", "0,1013.2"].join("\n");
    const mauvaisPath = path.join(dir, "pas-gps.csv");
    fsNode.writeFileSync(mauvaisPath, mauvaisCsv);

    const depotGps = page.locator("#contenu-vol .vol-depot").nth(0);
    await depotGps.locator('input[type="file"]').setInputFiles(mauvaisPath);
    await expect(depotGps.locator(".avertissement")).toBeVisible();
    await expect(depotGps.locator(".avertissement")).toContainText("Erreur");
  });
});
