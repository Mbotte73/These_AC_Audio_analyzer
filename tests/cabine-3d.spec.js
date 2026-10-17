// Tests de la page 3D de la cabine H145 (outils/cabine-3d) : interpolation des niveaux,
// volume intérieur, contenance de la carrosserie, cotes Airbus, couleurs de la tranche,
// bascule entre les rendus futuriste et réaliste.
const { test, expect } = require("@playwright/test");

// WebGL logiciel pour les machines sans carte graphique (sans effet ailleurs).
test.use({ launchOptions: { args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] } });

const URL_PAGE = "/outils/cabine-3d/cabine_H145_niveaux_sonores.html";

async function ouvrir(page) {
  const erreurs = [];
  page.on("pageerror", (e) => erreurs.push(e.message));
  page.on("console", (m) => {
    // les polices en ligne peuvent être indisponibles hors connexion : sans conséquence
    if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) erreurs.push(m.text());
  });
  await page.goto(URL_PAGE);
  await page.waitForFunction(() => window.__h145 && window.__h145.etat);
  return erreurs;
}

test.describe("page 3D de la cabine H145", () => {
  test.setTimeout(180_000);

  test("niveaux, volume, carrosserie et cotes Airbus", async ({ page }) => {
    const erreurs = await ouvrir(page);

    // démarrage en rendu futuriste
    expect(await page.evaluate(() => __h145.etat.rendu)).toBe("holo");
    await expect(page.locator("body")).toHaveClass(/holo/);

    // volume cabine + soute (coque lisse) : Airbus annonce 6,03 m³
    const vol = await page.evaluate(() => __h145.volumeModele(false));
    expect(Math.abs(vol - 6.03)).toBeLessThan(0.05);

    // niveau exact au droit de chaque micro, et borné par les niveaux des micros partout ailleurs
    expect(await page.evaluate(() => __h145.etat.mics.every((m) => __h145.dedans(...m.pos) && Math.abs(__h145.niveauEn(...m.pos) - m.niv) < 1e-9))).toBe(true);
    const bornes = await page.evaluate(() => {
      let mn = 1e9, mx = -1e9, n = 0, s = 12345;
      const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      for (let i = 0; i < 4000; i++) {
        const x = r() * 1.6 - 0.8, y = r() * 1.3, z = r() * 6 - 2.4;
        if (!__h145.dedans(x, y, z)) continue;
        n++; const L = __h145.niveauEn(x, y, z); mn = Math.min(mn, L); mx = Math.max(mx, L);
      }
      const niv = __h145.etat.mics.map((m) => m.niv);
      return { n, ok: mn >= Math.min(...niv) - 1e-9 && mx <= Math.max(...niv) + 1e-9 };
    });
    expect(bornes.n).toBeGreaterThan(500);
    expect(bornes.ok).toBe(true);

    // la carrosserie contient le volume du calcul, avec au moins 2 cm de marge
    const marge = await page.evaluate(() => {
      const H = __h145, d = H.etat.dim; let pire = 1e9;
      const dansPoly = (pts, x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
      const distPoly = (pts, x, y) => { let m = 1e9; for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1))); m = Math.min(m, Math.hypot(x - a.x - t * dx, y - a.y - t * dy)); } return m; };
      for (let z = -d.C; z <= d.L + d.S + 1e-9; z += 0.04) {
        const ext = H.sectionExt(z);
        for (const [x, y] of H.contour(H.profilEn(z), 0)) { const m = dansPoly(ext, x, y) ? distPoly(ext, x, y) : -distPoly(ext, x, y); pire = Math.min(pire, m); }
      }
      return pire;
    });
    expect(marge).toBeGreaterThan(0.02);

    // cotes Airbus (H145 D-3) : longueur hors tout 13,54 m rotor tournant, moyeu à 3,62 m du sol
    const cotes = await page.evaluate(() => ({ horsTout: __h145.Z_QUEUE - (__h145.Z_MAT - 5.4), moyeu: __h145.Y_MOYEU - __h145.Y_SOL }));
    expect(Math.abs(cotes.horsTout - 13.54)).toBeLessThan(0.01);
    expect(Math.abs(cotes.moyeu - 3.62)).toBeLessThan(0.01);

    expect(erreurs).toEqual([]);
  });

  test("la tranche affichée a les couleurs de la légende, dans les deux rendus", async ({ page }) => {
    const erreurs = await ouvrir(page);
    for (const rendu of ["holo", "reel"]) {
      if (rendu === "reel") { await page.locator("#renduReel").click(); await page.waitForFunction(() => __h145.renderer.shadowMap.enabled); }
      const r = await page.evaluate(() => {
        const H = __h145; H.choisirMode("dessus");
        const nuage = document.getElementById("afficheNuage"); if (nuage.checked) nuage.click();
        const tranche = document.getElementById("afficheTranche"); if (!tranche.checked) tranche.click();
        const x = 0.16, z = 0.9, y = H.etat.hTranche, L = H.niveauEn(x, y, z);
        H.camera.updateMatrixWorld();
        const v = new THREE.Vector3(x, y, z).project(H.camera), gl = H.renderer.getContext();
        const dpr = H.renderer.getPixelRatio(), W = gl.drawingBufferWidth, Hh = gl.drawingBufferHeight;
        const px = Math.round((v.x * 0.5 + 0.5) * W), py = Math.round((v.y * 0.5 + 0.5) * Hh);
        const lire = () => { H.renderer.render(H.scene, H.camera); const b = new Uint8Array(4 * 25); gl.readPixels(px - 2, py - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, b); const m = [0, 0, 0]; for (let i = 0; i < 25; i++) for (let k = 0; k < 3; k++) m[k] += b[i * 4 + k] / 25; return m; };
        const avec = lire(); tranche.click(); const sans = lire(); tranche.click();
        const a = 205 / 255, rendu = avec.map((c, k) => (c - (1 - a) * sans[k]) / a);
        // couleur attendue : palette viridis de la légende
        const [mn, mx] = H.echelle(), t = Math.min(Math.max((L - mn) / (mx - mn), 0), 1);
        const V = [[0,68,1,84],[0.067,72,26,108],[0.133,71,47,125],[0.2,65,68,135],[0.267,57,86,140],[0.333,49,104,142],[0.4,42,120,142],[0.467,35,136,142],[0.533,31,152,139],[0.6,34,168,132],[0.667,53,183,121],[0.733,84,197,104],[0.8,122,209,81],[0.867,165,219,54],[0.933,210,226,27],[1,253,231,37]];
        let i = 0; while (i < V.length - 2 && t > V[i + 1][0]) i++;
        const f = (t - V[i][0]) / (V[i + 1][0] - V[i][0]), attendu = [1, 2, 3].map((k) => V[i][k] + f * (V[i + 1][k] - V[i][k]));
        return { dpr, ecart: Math.max(...rendu.map((c, k) => Math.abs(c - attendu[k]))) };
      });
      expect(r.ecart, `rendu ${rendu}`).toBeLessThan(6);
    }
    expect(erreurs).toEqual([]);
  });

  test("bascule futuriste / réaliste sans perte des niveaux", async ({ page }) => {
    const erreurs = await ouvrir(page);
    await page.locator("#collerNiveaux").fill("80; 88,5; 99 90");
    await page.locator("#collerNiveaux").press("Enter");
    await page.locator("#renduReel").click();
    await page.waitForFunction(() => __h145.renderer.shadowMap.enabled && __h145.scene.environment !== null);
    await expect(page.locator("body")).not.toHaveClass(/holo/);
    await page.locator("#renduHolo").click();
    await page.waitForFunction(() => !__h145.renderer.shadowMap.enabled);
    await expect(page.locator("body")).toHaveClass(/holo/);
    expect(await page.evaluate(() => __h145.etat.mics.map((m) => m.niv).join(","))).toBe("80,88.5,99,90");
    expect(await page.evaluate(() => __h145.etat.mics.every((m) => Math.abs(__h145.niveauEn(...m.pos) - m.niv) < 1e-9))).toBe(true);
    expect(erreurs).toEqual([]);
  });
});
