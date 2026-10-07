// Tests du mode "Ambulance" de l'onglet Trajet : bascule de mode, courbe de
// vitesse a la place de l'altitude, rejet des points GPS aberrants, trous de
// signal, couleur de trace par la vitesse, KML plaque au sol.
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { amplitudePourNiveauDbfs, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

async function chargerMesure(page, dir, dureeS) {
  const wavPath = path.join(dir, "mesure.wav");
  const txtPath = path.join(dir, "mesure.txt");
  const n = dureeS * 8000, canal = new Float64Array(n), amp = amplitudePourNiveauDbfs(-30);
  for (let i = 0; i < n; i++) canal[i] = amp * Math.sin(2 * Math.PI * 1000 * i / 8000);
  ecrireWavFichier(wavPath, 8000, [canal]);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([100]));
  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
  await page.locator('#tabsNav button[data-onglet="vol"]').click();
}

// 60 s a 10 m/s vers le nord, 1 point par seconde ; point 20 aberrant
// (saut de 300 m), perte du signal de 30 a 45 s (tunnel).
function gpsAvecDefauts(avecVitesse) {
  const lignes = [avecVitesse ? "Time (s),Latitude (°),Longitude (°),Height (m),Velocity (m/s)" : "Time (s),Latitude (°),Longitude (°),Height (m)"];
  for (let t = 0; t <= 60; t++) {
    if (t > 30 && t < 45) continue;
    let lat = 45 + (10 * t) / 111132, lon = 5;
    if (t === 20) lon += 300 / (111320 * Math.cos(45 * Math.PI / 180));
    lignes.push(`${t},${lat.toFixed(7)},${lon.toFixed(7)},200` + (avecVitesse ? ",10" : ""));
  }
  return lignes.join("\n");
}

async function deposerGps(page, dir, contenu) {
  const p = path.join(dir, "gps.csv");
  fsNode.writeFileSync(p, contenu);
  const depot = page.locator("#contenu-vol .vol-depot").nth(0);
  await depot.locator('input[type="file"]').setInputFiles(p);
  await expect(depot.locator(".filename")).toContainText("gps.csv");
}

test.describe("onglet Trajet — mode Ambulance", () => {
  test("bascule de mode : titre, options de couleur, retour a l'helicoptere", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-amb-"));
    await chargerMesure(page, dir, 4);
    await expect(page.locator('#tabsNav button[data-onglet="vol"]')).toHaveText("Trajet");
    await expect(page.locator("#contenu-vol h3")).toContainText("Vol");
    await page.selectOption("#vol-mode-transport", "ambulance");
    await expect(page.locator("#contenu-vol h3")).toContainText("Trajet");
    const options = await page.locator(".vol-couleur-trace select option").evaluateAll(os => os.map(o => o.value));
    expect(options).toEqual(["vitesse", "son"]);
    expect(await page.evaluate(() => volCouleurTrace)).toBe("vitesse");
    await page.selectOption("#vol-mode-transport", "helico");
    await expect(page.locator("#contenu-vol h3")).toContainText("Vol");
    const optionsHelico = await page.locator(".vol-couleur-trace select option").evaluateAll(os => os.map(o => o.value));
    expect(optionsHelico).toEqual(["altitude", "vitesse", "son"]);
  });

  test("vitesse Doppler : point aberrant rejete, trou de signal detecte, courbe de vitesse coupee au trou", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-amb-"));
    await chargerMesure(page, dir, 60);
    await page.selectOption("#vol-mode-transport", "ambulance");
    await deposerGps(page, dir, gpsAvecDefauts(true));
    const r = await page.evaluate(() => {
      const ok = volPointsGpsValides(), segs = volSegmentsGps(), v = volVitessesKmh();
      let capture = null;
      const original = window.tracerCourbe;
      window.tracerCourbe = function (canvas, series, opts) { if (canvas.id === "c-vol-altitude") capture = { ys: series[0].ys.slice(), ylabel: opts.ylabel }; return original(canvas, series, opts); };
      redessinerVol();
      window.tracerCourbe = original;
      return { rejetes: ok.map((x, i) => x ? null : volGps.temps[i]).filter(x => x !== null), trous: segs.filter(s => s.trou).length,
        vMoy: v.filter(isFinite).reduce((a, b) => a + b, 0) / v.filter(isFinite).length, source: volGps._vitesseSource,
        coupures: capture.ys.filter(y => !isFinite(y)).length, ylabel: capture.ylabel };
    });
    expect(r.rejetes).toEqual([20]);
    expect(r.trous).toBe(1);
    expect(r.source).toBe("Doppler GPS");
    expect(r.vMoy).toBeCloseTo(36, 5);
    expect(r.coupures).toBe(1);
    expect(r.ylabel).toBe("vitesse (km/h)");
  });

  test("vitesse derivee des positions (sans colonne Velocity) : ~36 km/h malgre le point aberrant", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-amb-"));
    await chargerMesure(page, dir, 60);
    await page.selectOption("#vol-mode-transport", "ambulance");
    await deposerGps(page, dir, gpsAvecDefauts(false));
    const r = await page.evaluate(() => {
      const v = volVitessesKmh().filter(isFinite);
      return { source: volGps._vitesseSource, min: Math.min(...v), max: Math.max(...v) };
    });
    expect(r.source).toBe("dérivée des positions GPS");
    expect(r.min).toBeGreaterThan(34);
    expect(r.max).toBeLessThan(38);
  });

  test("export KML en mode ambulance : plaque au sol, sans segment sur le trou ni le point aberrant", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-amb-"));
    await chargerMesure(page, dir, 60);
    await page.selectOption("#vol-mode-transport", "ambulance");
    await deposerGps(page, dir, gpsAvecDefauts(true));
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter la trajectoire en KML" }).click();
    const kml = fsNode.readFileSync(await (await dl).path(), "utf8");
    expect(kml).not.toContain("<altitudeMode>absolute</altitudeMode>");
    expect(kml).toContain("Suivi du trajet");
    // 47 points GPS (0-30 s et 45-60 s), 1 rejete -> 46 retenus -> 45 segments, dont 1 trou non exporte
    const segments = (kml.match(/<TimeSpan>/g) || []).length;
    expect(segments).toBe(44);
  });
});
