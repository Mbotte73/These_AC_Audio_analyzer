"use strict";
/* =========================================================================
   PHYPHOX.JS — parseur tolerant des exports CSV de l'application phyphox
   (GPS/localisation, accelerometre "acceleration lineaire"), pour l'onglet
   "Vol". Les noms de colonnes varient selon la version de l'app et la
   langue du telephone : la detection se fait par mots-cles, pas par
   position fixe.

   Format phyphox usuel (export CSV d'un capteur) : une ligne d'en-tete,
   puis une ligne par echantillon. Le separateur est "," en general, mais
   certains telephones configures en locale europeenne exportent avec ";"
   comme separateur de colonnes et "," comme separateur decimal : les deux
   formes sont acceptees ici.

   D'apres la documentation et le forum officiels de phyphox (consultes en
   session), l'export CSV simple d'un capteur ne contient PAS d'horodatage
   absolu (heure systeme) : seulement un temps relatif en secondes depuis le
   debut de l'enregistrement. Le format JSON/zip complet peut en contenir
   un, sous une forme non garantie selon la version. Par prudence, cette
   detection reste tolerante (voir trouverColonneTempsAbsolu) mais NE DOIT
   PAS etre consideree comme fiable sans verification sur un export reel :
   le reglage manuel du decalage (vol.js) est le filet de securite.
   ========================================================================= */

function normaliserTexteColonne(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function detecterSeparateurCsv(ligneEntete) {
  const nPointVirgule = (ligneEntete.match(/;/g) || []).length;
  const nVirgule = (ligneEntete.match(/,/g) || []).length;
  return nPointVirgule > nVirgule ? ";" : ",";
}

function analyserCsvPhyphox(texte) {
  const lignes = texte.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
  if (!lignes.length) throw new Error("Fichier CSV vide.");
  const sep = detecterSeparateurCsv(lignes[0]);

  const entetes = lignes[0].split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
  const entetesNorm = entetes.map(normaliserTexteColonne);

  const donnees = [];
  for (let i = 1; i < lignes.length; i++) {
    const cellules = lignes[i].split(sep).map(c => {
      c = c.trim().replace(/^"|"$/g, "");
      if (sep === ";") c = c.replace(",", ".");
      return parseFloat(c);
    });
    donnees.push(cellules);
  }
  return { entetes, entetesNorm, donnees };
}

function trouverColonne(entetesNorm, motsCles, exclusions) {
  exclusions = exclusions || [];
  for (let i = 0; i < entetesNorm.length; i++) {
    const h = entetesNorm[i];
    if (exclusions.some(ex => h.includes(ex))) continue;
    if (motsCles.some(mc => h.includes(mc))) return i;
  }
  return -1;
}

// Colonne d'axe (x, y ou z) d'un capteur vectoriel : le mot-cle doit
// apparaitre comme lettre isolee (pas a l'interieur d'un autre mot), dans
// une colonne qui contient par ailleurs "acceleration".
function trouverColonneAxe(entetesNorm, axe) {
  const re = new RegExp("(^|[^a-z])" + axe + "([^a-z]|$)");
  for (let i = 0; i < entetesNorm.length; i++) {
    if (entetesNorm[i].includes("acceleration") && re.test(entetesNorm[i])) return i;
  }
  return -1;
}

// Cf. avertissement en tete de fichier : detection defensive, non garantie
// fiable. Une colonne "system time" / "temps systeme" / "unix" / "epoch"
// dont la premiere valeur ressemble a un temps Unix (secondes depuis 1970,
// donc > 1e9) est interpretee comme horodatage absolu de depart.
function trouverColonneTempsAbsolu(entetesNorm) {
  return trouverColonne(entetesNorm, ["system time", "temps systeme", "unix", "epoch"]);
}

function extraireInstantAbsoluDebut(entetesNorm, donnees) {
  const iAbs = trouverColonneTempsAbsolu(entetesNorm);
  if (iAbs < 0) return null;
  for (const ligne of donnees) {
    const v = ligne[iAbs];
    if (isFinite(v) && v > 1e9) return new Date(v * 1000);
  }
  return null;
}

function parserGpsPhyphox(texte) {
  const { entetesNorm, donnees } = analyserCsvPhyphox(texte);
  const iT = trouverColonne(entetesNorm, ["time", "temps"]);
  const iLat = trouverColonne(entetesNorm, ["latitude"]);
  const iLon = trouverColonne(entetesNorm, ["longitude"]);
  const iAlt = trouverColonne(entetesNorm, ["height", "altitude", "hauteur"], ["accuracy", "precision"]);

  if (iT < 0 || iLat < 0 || iLon < 0) {
    throw new Error("Fichier non reconnu comme export GPS phyphox : colonnes temps/latitude/longitude introuvables. Verifiez qu'il s'agit bien d'un export du capteur \"Localisation\" (GPS).");
  }

  const temps = [], lat = [], lon = [], alt = [];
  for (const l of donnees) {
    if (!isFinite(l[iT]) || !isFinite(l[iLat]) || !isFinite(l[iLon])) continue;
    temps.push(l[iT]); lat.push(l[iLat]); lon.push(l[iLon]);
    alt.push(iAlt >= 0 && isFinite(l[iAlt]) ? l[iAlt] : null);
  }
  if (!temps.length) throw new Error("Export GPS phyphox reconnu, mais aucune ligne de donnees valide n'a ete trouvee.");

  return {
    temps, lat, lon, alt,
    altitudeDisponible: iAlt >= 0,
    instantAbsoluDebut: extraireInstantAbsoluDebut(entetesNorm, donnees),
  };
}

function magnitude3(x, y, z) { return Math.sqrt(x*x + y*y + z*z); }

function parserAccelPhyphox(texte) {
  const { entetesNorm, donnees } = analyserCsvPhyphox(texte);
  const iT = trouverColonne(entetesNorm, ["time", "temps"]);
  if (iT < 0) throw new Error("Fichier non reconnu comme export accelerometre phyphox : colonne de temps introuvable.");

  const iX = trouverColonneAxe(entetesNorm, "x");
  const iY = trouverColonneAxe(entetesNorm, "y");
  const iZ = trouverColonneAxe(entetesNorm, "z");
  const parAxes = iX >= 0 && iY >= 0 && iZ >= 0;

  let iMag = -1;
  if (!parAxes) iMag = trouverColonne(entetesNorm, ["acceleration"]);
  if (!parAxes && iMag < 0) {
    throw new Error("Fichier non reconnu comme export accelerometre phyphox : colonnes d'acceleration (x/y/z ou magnitude) introuvables. Verifiez qu'il s'agit bien d'un export du capteur \"Acceleration lineaire\".");
  }

  const temps = [], magnitude = [];
  for (const l of donnees) {
    if (!isFinite(l[iT])) continue;
    let m;
    if (parAxes && isFinite(l[iX]) && isFinite(l[iY]) && isFinite(l[iZ])) m = magnitude3(l[iX], l[iY], l[iZ]);
    else if (iMag >= 0 && isFinite(l[iMag])) m = Math.abs(l[iMag]);
    else continue;
    temps.push(l[iT]); magnitude.push(m);
  }
  if (!temps.length) throw new Error("Export accelerometre phyphox reconnu, mais aucune ligne de donnees valide n'a ete trouvee.");

  return {
    temps, magnitude, parAxes,
    instantAbsoluDebut: extraireInstantAbsoluDebut(entetesNorm, donnees),
  };
}
