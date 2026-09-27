// Tests de l'onglet "Vol" : lecture animee (Tache A) et trace GPS coloree par
// le niveau sonore moyen (Tache B). Complete tests/vol.spec.js (parsing
// phyphox, recalage, LAeq court terme, deja couverts la-bas).
const { test, expect } = require("@playwright/test");
const os = require("os");
const path = require("path");
const fsNode = require("fs");
const { amplitudePourNiveauDbfs, construireCalibrationTxt, ecrireWavFichier } = require("./helpers/wav");

// Signal avec un saut de niveau net (quasi silencieux -40 dBFS sur la
// premiere moitie, fort -6 dBFS sur la seconde) : le niveau sonore moyen
// resultant croit nettement dans le temps, un ordre different de la trace
// d'altitude choisie dans les tests ci-dessous (qui monte puis redescend) —
// utile pour verifier que la bascule de couleur (Tache B) produit bien des
// couleurs differentes selon le mode.
function genererSignalAvecSautNiveau(dureeS, fsHz = 44100) {
  const n = Math.round(dureeS * fsHz);
  const canal = new Float64Array(n);
  const freq = 1000;
  const ampQuiet = amplitudePourNiveauDbfs(-40);
  const ampLoud = amplitudePourNiveauDbfs(-6);
  for (let i = 0; i < n; i++) {
    const amplitude = i < n/2 ? ampQuiet : ampLoud;
    canal[i] = amplitude * Math.sin(2*Math.PI*freq*i/fsHz);
  }
  return canal;
}

async function chargerMesureVol(page, dir, dureeS) {
  const wavPath = path.join(dir, "mesure.wav");
  const txtPath = path.join(dir, "mesure.txt");
  const canal = genererSignalAvecSautNiveau(dureeS);
  ecrireWavFichier(wavPath, 44100, [canal]);
  fsNode.writeFileSync(txtPath, construireCalibrationTxt([100]));

  await page.goto("/index.html");
  await page.locator("#inputFichiers").setInputFiles([wavPath, txtPath]);
  await expect(page.locator("#btnAnalyser")).toBeEnabled();
  await page.locator("#btnAnalyser").click();
  await page.locator("#tabsNav button").first().waitFor();
  await page.locator('#tabsNav button[data-onglet="vol"]').click();
}

async function deposerGpsTroisPoints(page, dir, dureeS) {
  const gpsCsv = [
    "Time (s),Latitude (°),Longitude (°),Height (m)",
    `0,45.000,5.000,1000`,
    `${dureeS/2},45.001,5.001,1010`,
    `${dureeS},45.002,5.002,1005`,
  ].join("\n");
  const gpsPath = path.join(dir, "gps.csv");
  fsNode.writeFileSync(gpsPath, gpsCsv);
  const depotGps = page.locator("#contenu-vol .vol-depot").nth(0);
  await depotGps.locator('input[type="file"]').setInputFiles(gpsPath);
  // ".avertissement" passe a "hidden" des le debut du gestionnaire (avant
  // meme la lecture du fichier), donc pas un signal fiable de fin de
  // traitement ; ".filename" n'est rempli qu'apres redessinerVol().
  await expect(depotGps.locator(".filename")).toContainText("gps.csv");
}

test.describe("vol.js — interpolation du niveau sonore (Tache B, sans fichier)", () => {
  test("niveauInterpoleVol : interpolation lineaire entre points connus, et pas d'extrapolation hors plage", async ({ page }) => {
    await page.goto("/index.html");
    const res = await page.evaluate(() => {
      const temps = [0, 1, 2, 3];
      const niveaux = [50, 60, 70, 80];
      return {
        milieu: niveauInterpoleVol(temps, niveaux, 0.5),   // entre 50 et 60 -> 55
        exact: niveauInterpoleVol(temps, niveaux, 2),      // pile sur un point -> 70
        avant: niveauInterpoleVol(temps, niveaux, -5),     // hors plage (avant) -> valeur la plus proche (50)
        apres: niveauInterpoleVol(temps, niveaux, 100),    // hors plage (apres) -> valeur la plus proche (80)
        troisQuarts: niveauInterpoleVol(temps, niveaux, 2.75), // entre 70 et 80 -> 77.5
      };
    });
    expect(res.milieu).toBeCloseTo(55, 6);
    expect(res.exact).toBeCloseTo(70, 6);
    expect(res.avant).toBeCloseTo(50, 6);
    expect(res.apres).toBeCloseTo(80, 6);
    expect(res.troisQuarts).toBeCloseTo(77.5, 6);
  });

  test("volTronquerSeries : ne garde que les points jusqu'a la limite (serie croissante)", async ({ page }) => {
    await page.goto("/index.html");
    const res = await page.evaluate(() => {
      const xs = [0, 1, 2, 3, 4], ys = [10, 20, 30, 40, 50];
      return volTronquerSeries(xs, ys, 2.5);
    });
    expect(res.xs).toEqual([0, 1, 2]);
    expect(res.ys).toEqual([10, 20, 30]);
  });
});

test.describe("vol.js — regression export pendant une lecture en pause (Tache A.5, sans fichier)", () => {
  test("volModeLectureActif() : desactive pendant preparerVueImpression (classe \"impression\"), meme avec une position de lecture active", async ({ page }) => {
    await page.goto("/index.html");
    const res = await page.evaluate(() => {
      volLecturePosition = 5;
      const avant = volModeLectureActif();
      document.body.classList.add("impression");
      const pendant = volModeLectureActif();
      document.body.classList.remove("impression");
      const apres = volModeLectureActif();
      volLecturePosition = null;
      return { avant, pendant, apres };
    });
    expect(res.avant).toBe(true);
    expect(res.pendant).toBe(false);
    expect(res.apres).toBe(true);
  });
});

test.describe("onglet Vol — lecture animee (Tache A)", () => {
  test("glissiere : les 3 graphiques se tronquent au temps courant, avec une ligne verticale a cette position", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-lecture-"));
    await chargerMesureVol(page, dir, 4);

    const resultat = await page.evaluate(() => {
      const domaine = volDomaineComplet();
      const positionCible = domaine.min + (domaine.max - domaine.min) * 0.4;

      const slider = document.querySelector(".vol-lecture-slider");
      slider.value = String(positionCible);
      slider.dispatchEvent(new Event("input"));

      const captures = [];
      const original = window.tracerCourbe;
      window.tracerCourbe = function (canvas, series, opts) {
        if (canvas.id === "c-vol-son") {
          captures.push({ longueur: series[0].xs.length, ligneVerticaleX: opts.ligneVerticaleX, dernierX: series[0].xs[series[0].xs.length-1] });
        }
        return original(canvas, series, opts);
      };
      redessinerVol();
      window.tracerCourbe = original;

      const longueurComplete = resultatsBase[voiesAnalysees()[0]].temporel.niveaux.length;
      return { captures, longueurComplete, positionCible, positionApres: volLecturePosition };
    });

    expect(resultat.positionApres).toBeCloseTo(resultat.positionCible, 6);
    expect(resultat.captures.length).toBeGreaterThan(0);
    const derniere = resultat.captures[resultat.captures.length-1];
    expect(derniere.longueur).toBeGreaterThan(0);
    expect(derniere.longueur).toBeLessThan(resultat.longueurComplete);
    expect(derniere.dernierX).toBeLessThanOrEqual(resultat.positionCible + 1e-9);
    expect(derniere.ligneVerticaleX).toBeCloseTo(resultat.positionCible, 6);
  });

  test("bouton lecture/pause : la position avance puis la lecture se met en pause automatiquement a la fin du vol", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-lecture-"));
    await chargerMesureVol(page, dir, 4); // vol tres court : la fin de lecture est atteinte vite, meme a vitesse x1

    await page.evaluate(() => { volLectureVitesse = 1; });
    await page.getByRole("button", { name: "▶ Lecture" }).click();
    await expect(page.getByRole("button", { name: "⏸ Pause" })).toBeVisible();
    // Repasse a "▶ Lecture" une fois la fin du vol atteinte (pause automatique).
    await expect(page.getByRole("button", { name: "▶ Lecture" })).toBeVisible({ timeout: 10000 });

    const etat = await page.evaluate(() => ({
      position: volLecturePosition, domaineMax: volDomaineComplet().max, enCours: volLectureEnCours,
    }));
    expect(etat.enCours).toBe(false);
    expect(etat.position).toBeCloseTo(etat.domaineMax, 5);
  });

  test("zoom lie : la fenetre zoomee glisse pour garder le curseur de lecture visible, a largeur constante", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-lecture-"));
    await chargerMesureVol(page, dir, 10);

    const resultat = await page.evaluate(() => {
      const domaine = volDomaineComplet();
      volZoomMin = domaine.min;
      volZoomMax = domaine.min + (domaine.max - domaine.min) * 0.2;
      const largeur = volZoomMax - volZoomMin;

      volLecturePosition = volZoomMax + (domaine.max - domaine.min) * 0.3; // hors de la fenetre zoomee
      volSuivreFenetreZoom();

      return {
        largeurConservee: Math.abs((volZoomMax - volZoomMin) - largeur) < 1e-9,
        positionVisible: volLecturePosition >= volZoomMin - 1e-9 && volLecturePosition <= volZoomMax + 1e-9,
        colleeAuBord: Math.abs(volZoomMax - volLecturePosition) < 1e-9,
      };
    });
    expect(resultat.largeurConservee).toBe(true);
    expect(resultat.positionVisible).toBe(true);
    expect(resultat.colleeAuBord).toBe(true);
  });

  test("export PDF/PNG (preparerVueImpression) : courbes completes et sans ligne verticale, meme avec une lecture en pause a mi-vol", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-lecture-"));
    await chargerMesureVol(page, dir, 4);

    const resultat = await page.evaluate(() => {
      volLecturePosition = volDomaineComplet().max / 2; // lecture en pause a mi-vol
      volLectureEnCours = false;

      const captures = [];
      const original = window.tracerCourbe;
      window.tracerCourbe = function (canvas, series, opts) {
        if (canvas.id === "c-vol-son" || canvas.id === "c-vol-accel") {
          captures.push({ id: canvas.id, longueur: series[0] ? series[0].xs.length : 0, ligneVerticaleX: opts.ligneVerticaleX });
        }
        return original(canvas, series, opts);
      };
      preparerVueImpression();
      window.tracerCourbe = original;

      const longueurComplete = resultatsBase[voiesAnalysees()[0]].temporel.niveaux.length;
      return { captures, longueurComplete };
    });

    const captureSon = resultat.captures.find(c => c.id === "c-vol-son");
    expect(captureSon).toBeTruthy();
    expect(captureSon.longueur).toBe(resultat.longueurComplete);
    expect(captureSon.ligneVerticaleX === null || captureSon.ligneVerticaleX === undefined).toBe(true);
  });
});

test.describe("onglet Vol — trace GPS coloree par le niveau sonore (Tache B)", () => {
  test("bascule altitude / niveau sonore : couleurs de segments differentes sur la trajectoire", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-couleur-"));
    await chargerMesureVol(page, dir, 4);
    await deposerGpsTroisPoints(page, dir, 4);

    const couleurs = await page.evaluate(() => {
      function couleursSegments() {
        return volTrajectoireLayer.getLayers().filter(l => l instanceof L.Polyline).map(l => l.options.color);
      }
      volCouleurTrace = "altitude"; redessinerVol();
      const alt = couleursSegments();
      volCouleurTrace = "son"; redessinerVol();
      const son = couleursSegments();
      return { alt, son };
    });

    expect(couleurs.alt.length).toBe(2);
    expect(couleurs.son.length).toBe(2);
    expect(couleurs.son).not.toEqual(couleurs.alt);
  });

  test("export KML : suit le mode de coloration affiche a l'ecran, pas toujours l'altitude", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-couleur-"));
    await chargerMesureVol(page, dir, 4);
    await deposerGpsTroisPoints(page, dir, 4);

    const selCouleur = page.locator("#contenu-vol .vol-couleur-trace select");

    await selCouleur.selectOption("altitude");
    const dlAlt = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter la trajectoire en KML" }).click();
    const kmlAltitude = fsNode.readFileSync(await (await dlAlt).path(), "utf8");

    await selCouleur.selectOption("son");
    const dlSon = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter la trajectoire en KML" }).click();
    const kmlSon = fsNode.readFileSync(await (await dlSon).path(), "utf8");

    expect(kmlSon).not.toEqual(kmlAltitude);
  });

  test("legende : titre et unite s'adaptent au mode courant (Altitude (m) vs Niveau sonore)", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-couleur-"));
    await chargerMesureVol(page, dir, 4);
    await deposerGpsTroisPoints(page, dir, 4);

    await expect(page.locator("#contenu-vol .vol-legende-labels span").nth(1)).toHaveText("Altitude (m)");
    await page.locator("#contenu-vol .vol-couleur-trace select").selectOption("son");
    await expect(page.locator("#contenu-vol .vol-legende-labels span").nth(1)).toContainText("Niveau sonore moyen");
  });

  test("option \"Niveau sonore\" désactivée quand aucune voie valide n'est retenue, et repli automatique sur \"Altitude\"", async ({ page }) => {
    const dir = await fsNode.promises.mkdtemp(path.join(os.tmpdir(), "aac-test-vol-couleur-"));
    await chargerMesureVol(page, dir, 4);

    const res = await page.evaluate(() => {
      volCouleurTrace = "son";
      const original = window.volVoiesValides;
      window.volVoiesValides = () => []; // simule "aucune voie valide" (cf. Tache B.4)
      mettreAJourControleCouleurTraceVol();
      const disabledApres = volControleCouleurTrace.optSon.disabled;
      const modeApres = volCouleurTrace;
      window.volVoiesValides = original;
      return { disabledApres, modeApres };
    });
    expect(res.disabledApres).toBe(true);
    expect(res.modeApres).toBe("altitude");
  });
});
