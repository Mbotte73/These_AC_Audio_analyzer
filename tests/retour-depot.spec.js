// Retour immediat au depot du fichier (point A) : un message "Lecture de
// <nom>..." doit apparaitre des la reception du fichier, AVANT la fin de la
// lecture (fichierWav.arrayBuffer() / fichierTxt.text(), potentiellement
// longue sur un fichier volumineux). Verifie en appelant traiterFichiers()
// directement sans l'attendre : puisque la fonction est asynchrone et pose
// le message de statut avant son premier `await`, lire le DOM juste apres
// l'appel (sans attendre la promesse) capture de façon deterministe l'etat
// "en cours de lecture", sans dependre d'un delai reel ni d'un gros fichier.
const { test, expect } = require("@playwright/test");
const { genererTonPur, construireWav } = require("./helpers/wav");

test.describe("retour immediat au depot du fichier (point A)", () => {
  test("WAV : message 'Lecture de ...' affiche avant la fin de la lecture, puis confirmation avec durée", async ({ page }) => {
    await page.goto("/index.html");
    const { fs, canaux } = genererTonPur({ freqHz: 1000, niveauDbfsRms: -20, dureeS: 1, nCh: 2 });
    const octets = Array.from(construireWav(fs, canaux));

    const resultat = await page.evaluate(({ octets, nom }) => {
      const file = new File([new Uint8Array(octets)], nom);
      const promesse = traiterFichiers([file]);
      const messageImmediat = document.getElementById("statutAnalyse").textContent;
      return promesse.then(() => ({
        messageImmediat,
        nomWavApres: document.getElementById("nomWav").textContent,
        statutApres: document.getElementById("statutAnalyse").textContent,
      }));
    }, { octets, nom: "depot-test.wav" });

    expect(resultat.messageImmediat).toBe("Lecture de depot-test.wav…");
    expect(resultat.nomWavApres).toContain("depot-test.wav");
    expect(resultat.nomWavApres).toContain("1 s");
    expect(resultat.nomWavApres).toContain("2 voies");
    expect(resultat.statutApres).toBe("");
  });

  test("TXT seul : message 'Lecture de ...' affiche puis effacé, aucun cas silencieux", async ({ page }) => {
    await page.goto("/index.html");
    const resultat = await page.evaluate(() => {
      const file = new File(["Date et heure : 2026-09-20 14:30:00"], "meta-test.txt", { type: "text/plain" });
      const promesse = traiterFichiers([file]);
      const messageImmediat = document.getElementById("statutAnalyse").textContent;
      return promesse.then(() => ({
        messageImmediat,
        nomTxtApres: document.getElementById("nomTxt").textContent,
        statutApres: document.getElementById("statutAnalyse").textContent,
      }));
    });
    expect(resultat.messageImmediat).toBe("Lecture de meta-test.txt…");
    expect(resultat.nomTxtApres).toContain("meta-test.txt");
    expect(resultat.statutApres).toBe("");
  });
});
