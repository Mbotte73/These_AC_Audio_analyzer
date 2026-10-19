"use strict";
/* =========================================================================
   CASQUE.JS — vue "Atténuation d'un casque" : perte par insertion (IL) d'un
   casque antibruit (cache-oreilles de nouveau-né) mesurée sur banc, avec
   une enceinte fixe qui diffuse un bruit rose.

   Principe (perte par insertion, esprit ISO 4869-3) :
     - un micro "sous le casque" (posé sur la plaque, casque retiré puis mis),
     - un micro de "référence" hors du casque, qui suit les variations de
       niveau de l'enceinte entre les mesures,
     - IL(f) = [Lref − Lmic]_avec − [Lref − Lmic]_sans, par tiers d'octave.
   La sensibilité de chaque micro et l'étalonnage s'annulent dans cette
   double différence : l'atténuation est juste même sans fichier .TXT.
   Chaque fichier "avec casque" est une pose (casque retiré puis remis) :
   la dispersion entre poses est l'incertitude de mise en place.

   Vue indépendante des mesures de transport : ses propres fichiers, ses
   propres résultats, aucune variable partagée avec app.js hormis les
   fonctions de calcul (dsp.js) et de tracé (charts.js).
   ========================================================================= */

// Écart minimal signal / bruit de fond, par bande, pour qu'une bande soit
// exploitable (règle usuelle des mesures d'isolement : 10 dB).
const CASQUE_ECART_FOND_DB = 10;

const casque = {
  sans: [],   // [{ nom, wav }]
  avec: [],   // une entrée par pose
  fond: [],   // facultatif : enceinte coupée
  txt: null, nomTxt: "",
  resultat: null,
};

const CASQUE_ZONES = [
  { cle: "sans", titre: "Sans casque", aide: "Micro nu sur la plaque. Un fichier suffit." },
  { cle: "avec", titre: "Avec casque", aide: "Un fichier par pose : retirer puis remettre le casque entre deux fichiers (3 à 5 poses)." },
  { cle: "fond", titre: "Bruit de fond (facultatif)", aide: "Enceinte coupée, casque en place. Sert à vérifier que chaque bande dépasse le bruit de fond d'au moins 10 dB." },
];

function casqueEl(tag, classe, texte) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texte !== undefined) e.textContent = texte;
  return e;
}

function casqueFormat(v, dec) { return isFinite(v) ? v.toFixed(dec).replace(".", ",") : "—"; }

/* ------------------------------------------------------------ bascule de vue */
function casqueChoisirMode(mode) {
  const estCasque = mode === "casque";
  document.getElementById("vueTransport").style.display = estCasque ? "none" : "";
  document.getElementById("vueCasque").style.display = estCasque ? "" : "none";
  document.body.classList.toggle("mode-casque", estCasque);
  document.querySelectorAll("#modesNav button").forEach(b => b.classList.toggle("actif", b.dataset.mode === mode));
  if (estCasque && !document.getElementById("casqueReglages")) casqueConstruireVue();
  // les graphiques déjà calculés ont été dessinés vue masquée ou à une autre largeur
  if (estCasque && casque.resultat) casqueAfficherResultat();
}

function casqueInitialiser() {
  document.querySelectorAll("#modesNav button").forEach(b => b.addEventListener("click", () => casqueChoisirMode(b.dataset.mode)));
  if (location.hash === "#casque") casqueChoisirMode("casque");
}

/* ------------------------------------------------------------ construction */
function casqueConstruireVue() {
  const vue = document.getElementById("vueCasque");
  vue.innerHTML = "";

  const intro = casqueEl("div", "panel no-print");
  intro.appendChild(casqueEl("h2", null, "Atténuation d'un casque antibruit"));
  intro.appendChild(casqueEl("p", "note",
    "Enceinte fixe qui diffuse un bruit rose, un micro sous le casque, un micro de référence à côté. " +
    "Enregistrez un fichier sans casque, puis un fichier par pose avec casque (bouton gris entre chaque). " +
    "L'outil calcule les spectres par tiers d'octave et l'atténuation du casque : " +
    "[référence − micro] avec casque, moins [référence − micro] sans casque. " +
    "L'étalonnage s'annule dans ce calcul : le .TXT n'est utile que pour afficher les spectres en dB SPL."));
  vue.appendChild(intro);

  const panFichiers = casqueEl("div", "panel no-print");
  panFichiers.appendChild(casqueEl("h2", null, "1. Fichiers .WAV (et .TXT d'étalonnage, facultatif)"));
  const zones = casqueEl("div", "casque-zones");
  for (const z of CASQUE_ZONES) zones.appendChild(casqueZoneDepot(z));
  panFichiers.appendChild(zones);
  const txt = casqueEl("div", "note");
  txt.id = "casqueTxt";
  panFichiers.appendChild(txt);
  vue.appendChild(panFichiers);

  const panReglages = casqueEl("div", "panel no-print");
  panReglages.id = "casqueReglages";
  panReglages.appendChild(casqueEl("h2", null, "2. Micros et calcul"));
  const grille = casqueEl("div", "pat-grille");
  const labMic = casqueEl("label", null, "Micro sous le casque");
  const selMic = document.createElement("select"); selMic.id = "casqueVoieMic";
  labMic.appendChild(selMic);
  const labRef = casqueEl("label", null, "Micro de référence (hors du casque)");
  const selRef = document.createElement("select"); selRef.id = "casqueVoieRef";
  labRef.appendChild(selRef);
  const labMarge = casqueEl("label", null, "Secondes ignorées au début et à la fin de chaque fichier");
  const marge = document.createElement("input");
  marge.type = "number"; marge.id = "casqueMarge"; marge.min = "0"; marge.step = "0.5"; marge.value = "2";
  labMarge.appendChild(marge);
  grille.append(labMic, labRef, labMarge);
  panReglages.appendChild(grille);
  const ligne = casqueEl("div", "pat-actions");
  const btn = casqueEl("button", "principal", "Calculer l'atténuation");
  btn.id = "casqueCalculer"; btn.type = "button";
  btn.addEventListener("click", casqueCalculerEtAfficher);
  ligne.appendChild(btn);
  panReglages.appendChild(ligne);
  vue.appendChild(panReglages);

  const res = casqueEl("div", "panel");
  res.id = "casqueResultats";
  res.style.display = "none";
  vue.appendChild(res);

  casqueMettreAJourFichiers();
}

function casqueZoneDepot(z) {
  const bloc = casqueEl("div", "vol-depot casque-depot");
  bloc.appendChild(casqueEl("div", "vol-depot-titre", z.titre));
  const drop = casqueEl("div", "drop");
  drop.id = `casqueDrop-${z.cle}`;
  drop.appendChild(casqueEl("div", null, "Déposez ici, ou cliquez pour choisir"));
  const input = document.createElement("input");
  input.type = "file"; input.multiple = true; input.accept = ".wav,.txt";
  input.id = `casqueInput-${z.cle}`;
  drop.appendChild(input);
  drop.addEventListener("click", (e) => { if (e.target !== input) input.click(); });
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files.length) casqueDeposer(z.cle, e.dataTransfer.files);
  });
  input.addEventListener("change", () => { if (input.files.length) casqueDeposer(z.cle, input.files); input.value = ""; });
  bloc.appendChild(drop);
  bloc.appendChild(casqueEl("div", "note", z.aide));
  const liste = casqueEl("ul", "casque-liste");
  liste.id = `casqueListe-${z.cle}`;
  bloc.appendChild(liste);
  return bloc;
}

async function casqueDeposer(cle, fichiers) {
  const erreurs = [];
  for (const f of Array.from(fichiers)) {
    if (/\.txt$/i.test(f.name)) {
      casque.txt = await f.text(); casque.nomTxt = f.name;
    } else if (/\.wav$/i.test(f.name)) {
      try {
        const wav = lireWav(await f.arrayBuffer());
        if (cle === "fond") casque.fond = [{ nom: f.name, wav }];
        else casque[cle].push({ nom: f.name, wav });
      } catch (err) { erreurs.push(`${f.name} : ${err.message}`); }
    } else {
      erreurs.push(`${f.name} : extension non reconnue (.wav ou .txt attendu).`);
    }
  }
  if (erreurs.length) alert("Fichier(s) non chargé(s) :\n" + erreurs.join("\n"));
  casqueMettreAJourFichiers();
}

function casqueMettreAJourFichiers() {
  for (const z of CASQUE_ZONES) {
    const ul = document.getElementById(`casqueListe-${z.cle}`);
    ul.innerHTML = "";
    casque[z.cle].forEach((e, i) => {
      const li = document.createElement("li");
      const prefixe = z.cle === "avec" ? `Pose ${i + 1} : ` : "";
      li.appendChild(document.createTextNode(`${prefixe}${e.nom} (${formatDureeCourte(e.wav.dureeS)}, ${e.wav.nCh} voie${e.wav.nCh > 1 ? "s" : ""})`));
      const x = casqueEl("button", "casque-retirer", "retirer");
      x.type = "button";
      x.addEventListener("click", () => { casque[z.cle].splice(i, 1); casqueMettreAJourFichiers(); });
      li.appendChild(x);
      ul.appendChild(li);
    });
  }
  const cal = casque.txt ? lireCalibration(casque.txt) : null;
  document.getElementById("casqueTxt").textContent = casque.txt
    ? `Étalonnage : ${casque.nomTxt} (appliqué à tous les fichiers ; voies renseignées : ${[0, 1, 2, 3].filter(v => cal[v] !== null).map(v => v + 1).join(", ") || "aucune"}).`
    : "Pas de .TXT : spectres en dBFS. L'atténuation reste juste.";

  // voies proposées : celles présentes dans tous les fichiers
  const tous = [...casque.sans, ...casque.avec, ...casque.fond];
  const nCh = tous.length ? Math.min(...tous.map(e => e.wav.nCh)) : 4;
  casqueRemplirSelect(document.getElementById("casqueVoieMic"), nCh, false, 0);
  casqueRemplirSelect(document.getElementById("casqueVoieRef"), nCh, true, Math.min(1, nCh - 1));
  document.getElementById("casqueCalculer").disabled = !(casque.sans.length && casque.avec.length);
}

function casqueRemplirSelect(sel, nCh, avecAucune, defaut) {
  const avant = sel.value;
  sel.innerHTML = "";
  for (let v = 0; v < nCh; v++) sel.appendChild(new Option(nomVoie(v), String(v)));
  if (avecAucune) sel.appendChild(new Option("Aucune (enceinte supposée stable)", "-1"));
  const garde = [...sel.options].some(o => o.value === avant);
  sel.value = garde ? avant : String(nCh > 1 || !avecAucune ? defaut : -1);
}

/* ------------------------------------------------------------------ calcul */
// Niveaux par tiers d'octave d'une voie d'un fichier (non pondérés et A),
// corrigés de la réponse du micro, sur le fichier privé de ses marges.
function casqueNiveauxVoie(wav, v, cal, margeS) {
  const fs = wav.fs, brut = wav.canaux[v];
  const i0 = Math.round(margeS * fs), i1 = brut.length - i0;
  if (i1 - i0 < 2 * fs) return { erreur: "moins de 2 s analysables après retrait des marges" };
  const spl = cal ? cal[v] : null;
  const calibre = spl !== null && spl !== undefined;
  const pref = calibre ? PREF : 1.0;
  const gain = calibre ? PREF * Math.pow(10, spl / 20) : 1.0;
  const extrait = new Float64Array(i1 - i0);
  let crete = 0;
  for (let i = 0; i < extrait.length; i++) {
    const x = brut[i0 + i];
    if (Math.abs(x) > crete) crete = Math.abs(x);
    extrait[i] = x * gain;
  }
  const params = { nperseg: Math.min(pow2Below(fs), pow2Below(extrait.length)), recouvrement: 50, fenetre: "hann" };
  const { freqs, psd, df } = calculerPsd(extrait, fs, params);
  const psdC = new Float64Array(psd.length);
  for (let k = 0; k < psd.length; k++) psdC[k] = psd[k] * Math.pow(10, -correctionMicroDb(freqs[k]) / 10);
  return {
    calibre, crete, dureeS: extrait.length / fs,
    z: tiersOctave(freqs, psdC, df, null, pref),
    a: tiersOctave(freqs, psdC, df, "A", pref),
  };
}

function moyenneEnergie(liste) {
  let s = 0; for (const L of liste) s += Math.pow(10, L / 10);
  return 10 * Math.log10(s / liste.length);
}
function moyenne(liste) { return liste.reduce((a, b) => a + b, 0) / liste.length; }
function ecartType(liste) {
  if (liste.length < 2) return NaN;
  const m = moyenne(liste);
  return Math.sqrt(liste.reduce((a, b) => a + (b - m) * (b - m), 0) / (liste.length - 1));
}
function sommeEnergie(liste) {
  let s = 0; for (const L of liste) if (isFinite(L)) s += Math.pow(10, L / 10);
  return s > 0 ? 10 * Math.log10(s) : -Infinity;
}

function casqueCalculer({ vMic, vRef, margeS }) {
  if (!casque.sans.length || !casque.avec.length) return { erreur: "Il faut au moins un fichier sans casque et un fichier avec casque." };
  if (vRef === vMic) return { erreur: "Choisissez deux voies différentes pour le micro sous le casque et la référence." };
  const tous = [...casque.sans, ...casque.avec, ...casque.fond];
  const fs = tous[0].wav.fs;
  const autreFs = tous.find(e => e.wav.fs !== fs);
  if (autreFs) return { erreur: `Fréquences d'échantillonnage différentes (${fs} Hz et ${autreFs.wav.fs} Hz pour ${autreFs.nom}) : les fichiers ne viennent pas de la même configuration.` };

  const cal = casque.txt ? lireCalibration(casque.txt) : null;
  const avecRef = vRef >= 0;
  const mesurer = (liste) => liste.map(e => {
    const mic = casqueNiveauxVoie(e.wav, vMic, cal, margeS);
    const ref = avecRef ? casqueNiveauxVoie(e.wav, vRef, cal, margeS) : null;
    return { nom: e.nom, mic, ref };
  });
  const sans = mesurer(casque.sans), avec = mesurer(casque.avec), fond = mesurer(casque.fond);
  for (const m of [...sans, ...avec, ...fond]) {
    const err = m.mic.erreur || (m.ref && m.ref.erreur);
    if (err) return { erreur: `${m.nom} : ${err}. Réduisez les secondes ignorées ou vérifiez le fichier.` };
  }

  const avertissements = [];
  const satures = [...sans, ...avec].filter(m => m.mic.crete >= 0.999 || (m.ref && m.ref.crete >= 0.999)).map(m => m.nom);
  if (satures.length) avertissements.push(`Saturation détectée (crête à pleine échelle) dans : ${satures.join(", ")}. Baissez le volume de l'enceinte et refaites ces mesures : les niveaux saturés sont faux.`);
  if (!fond.length) avertissements.push("Pas de mesure de bruit de fond : impossible de vérifier que chaque bande dépasse le bruit ambiant de 10 dB. Les bandes où l'enceinte émet peu (graves surtout) peuvent sous-estimer l'atténuation.");
  if (avec.length < 3) avertissements.push(`${avec.length} pose${avec.length > 1 ? "" : " seulement"} avec casque : 3 à 5 poses (casque retiré puis remis) donnent la dispersion due à la mise en place.`);

  const nB = FREQ_TIERS_OCTAVE.length;
  const bandes = [];
  for (let k = 0; k < nB; k++) {
    const fc = FREQ_TIERS_OCTAVE[k];
    if (fc * Math.pow(2, 1 / 6) > fs / 2) continue;
    const Lsans = sans.map(m => m.mic.z[k]), Lavec = avec.map(m => m.mic.z[k]);
    const Rsans = avecRef ? sans.map(m => m.ref.z[k]) : null, Ravec = avecRef ? avec.map(m => m.ref.z[k]) : null;
    if (![...Lsans, ...Lavec, ...(Rsans || []), ...(Ravec || [])].every(isFinite)) continue;
    // écart référence − micro : la différence de sensibilité et les dérives
    // de l'enceinte s'annulent entre les deux mesures
    const Dsans = moyenne(Lsans.map((L, i) => (avecRef ? Rsans[i] : 0) - L));
    const ilPoses = Lavec.map((L, i) => ((avecRef ? Ravec[i] : 0) - L) - Dsans);
    const b = {
      k, fc,
      micSans: moyenneEnergie(Lsans), micAvec: moyenneEnergie(Lavec),
      refSans: avecRef ? moyenneEnergie(Rsans) : NaN, refAvec: avecRef ? moyenneEnergie(Ravec) : NaN,
      ilPoses, il: moyenne(ilPoses), sigma: ecartType(ilPoses),
      ilMin: Math.min(...ilPoses), ilMax: Math.max(...ilPoses),
      micFond: fond.length ? fond[0].mic.z[k] : NaN, refFond: fond.length && avecRef ? fond[0].ref.z[k] : NaN,
      statut: "non vérifié",
    };
    if (fond.length) {
      const ecartSans = Math.min(...Lsans) - b.micFond;
      const ecartRef = avecRef ? Math.min(...Rsans, ...Ravec) - b.refFond : Infinity;
      const ecartAvec = Math.min(...Lavec) - b.micFond;
      b.ecartAvec = ecartAvec;
      if (ecartSans < CASQUE_ECART_FOND_DB || ecartRef < CASQUE_ECART_FOND_DB) b.statut = "inexploitable";
      else if (ecartAvec < CASQUE_ECART_FOND_DB) b.statut = "minorée";
      else b.statut = "ok";
    }
    bandes.push(b);
  }
  if (!bandes.length) return { erreur: "Aucune bande de tiers d'octave exploitable (signal nul ?)." };

  // atténuation globale en dB(A) pour le bruit de l'essai : niveau A sans
  // casque, moins niveau A sans casque diminué de l'atténuation moyenne
  const utiles = bandes.filter(b => b.statut !== "inexploitable");
  const aSans = utiles.map(b => moyenneEnergie(sans.map(m => m.mic.a[b.k])));
  const dLA = sommeEnergie(aSans) - sommeEnergie(aSans.map((L, i) => L - utiles[i].il));
  const dLAminore = utiles.some(b => b.statut === "minorée");

  const unite = (m) => m.calibre ? "dB SPL" : "dBFS";
  return {
    fs, vMic, vRef, margeS, bandes, avertissements,
    nSans: sans.length, nAvec: avec.length, avecFond: fond.length > 0,
    poses: avec.map(m => m.nom),
    uniteMic: unite(sans[0].mic), uniteRef: avecRef ? unite(sans[0].ref) : "",
    dureeMinS: Math.min(...[...sans, ...avec].map(m => m.mic.dureeS)),
    dLA, dLAminore,
    fBas: utiles.length ? utiles[0].fc : NaN, fHaut: utiles.length ? utiles[utiles.length - 1].fc : NaN,
  };
}

/* ------------------------------------------------------------- affichage */
function casqueCalculerEtAfficher() {
  const vMic = parseInt(document.getElementById("casqueVoieMic").value, 10);
  const vRef = parseInt(document.getElementById("casqueVoieRef").value, 10);
  const margeS = Math.max(0, parseFloat(String(document.getElementById("casqueMarge").value).replace(",", ".")) || 0);
  casque.resultat = casqueCalculer({ vMic, vRef, margeS });
  casqueAfficherResultat();
}

function casqueAfficherResultat() {
  const zone = document.getElementById("casqueResultats");
  zone.style.display = "";
  zone.innerHTML = "";
  const r = casque.resultat;
  if (r.erreur) { zone.appendChild(casqueEl("div", "avertissement", r.erreur)); return; }

  zone.appendChild(casqueEl("h2", null, "3. Résultats"));
  for (const a of r.avertissements) zone.appendChild(casqueEl("div", "avertissement", a));

  const cartes = casqueEl("div", "synthese-niveaux");
  const carte = (valeur, label) => {
    const c = casqueEl("div", "carte");
    c.appendChild(casqueEl("div", "valeur", valeur));
    c.appendChild(casqueEl("div", "label", label));
    cartes.appendChild(c);
  };
  carte(`${r.dLAminore ? "≥ " : ""}${casqueFormat(r.dLA, 1)} dB(A)`, "atténuation globale, pour le bruit rose de l'essai");
  carte(String(r.nAvec), `pose${r.nAvec > 1 ? "s" : ""} avec casque`);
  const sigmas = r.bandes.map(b => b.sigma).filter(isFinite);
  if (sigmas.length) carte(`${casqueFormat(Math.max(...sigmas), 1)} dB`, "écart-type max entre poses");
  carte(`${formatHz(r.fBas)} à ${formatHz(r.fHaut)} Hz`, "bandes exploitées");
  zone.appendChild(cartes);
  zone.appendChild(casqueEl("p", "note",
    `Micro sous le casque : ${nomVoie(r.vMic)}. Référence : ${r.vRef >= 0 ? nomVoie(r.vRef) : "aucune (variations de l'enceinte non compensées)"}. ` +
    `${r.margeS} s ignorées au début et à la fin de chaque fichier, au moins ${casqueFormat(r.dureeMinS, 0)} s analysées par fichier. ` +
    `L'atténuation globale dépend du spectre du bruit : elle vaut pour le bruit rose de l'essai, pas pour un autre bruit (cabine, couveuse).`));

  const xs = r.bandes.map(b => b.fc);
  const xMin = xs[0] / Math.pow(2, 1 / 6), xMax = xs[xs.length - 1] * Math.pow(2, 1 / 6);
  const optsHz = { xlabel: "fréquence centrale du tiers d'octave (Hz)", logX: true, xMin, xMax, formatX: formatHz };
  const base = "casque";

  // Figure 1 et 2 : spectres mesurés
  const figSpectre = (id, titre, voie, unite, cleSans, cleAvec, cleFond) => creerBlocGraphique(id, titre, (canvas) => {
    const series = [
      { xs, ys: r.bandes.map(b => b[cleSans]), couleur: "#0f4c5c", label: r.nSans > 1 ? `sans casque (moyenne de ${r.nSans})` : "sans casque" },
      { xs, ys: r.bandes.map(b => b[cleAvec]), couleur: "#c98a3b", label: r.nAvec > 1 ? `avec casque (moyenne de ${r.nAvec} poses)` : "avec casque" },
    ];
    if (r.avecFond) series.push({ xs, ys: r.bandes.map(b => b[cleFond]), couleur: "#9aa0a8", tirets: [5, 4], label: "bruit de fond" });
    tracerCourbe(canvas, series, Object.assign({ titre: `${titre}, ${nomVoie(voie)}, par tiers d'octave, non pondéré`, ylabel: `niveau (${unite})` }, optsHz));
  }, () => `${base}_${id}.png`);

  zone.appendChild(casqueEl("h3", null, "Spectres mesurés"));
  zone.appendChild(figSpectre("spectre-micro", "Micro sous le casque", r.vMic, r.uniteMic, "micSans", "micAvec", "micFond"));
  if (r.vRef >= 0) zone.appendChild(figSpectre("spectre-reference", "Micro de référence", r.vRef, r.uniteRef, "refSans", "refAvec", "refFond"));

  // Figure 3 : atténuation
  zone.appendChild(casqueEl("h3", null, "Atténuation du casque"));
  zone.appendChild(creerBlocGraphique("attenuation", "Atténuation", (canvas) => {
    const ok = (b) => b.statut === "ok" || b.statut === "non vérifié";
    const series = [{ xs, ys: r.bandes.map(b => ok(b) ? b.il : NaN), couleur: "#7a3b8a", label: r.nAvec > 1 ? `moyenne des ${r.nAvec} poses` : "atténuation" }];
    if (r.nAvec > 1) {
      series.push({ xs, ys: r.bandes.map(b => ok(b) ? b.il + b.sigma : NaN), couleur: "#b48cc0", tirets: [5, 4], label: "± 1 écart-type" });
      series.push({ xs, ys: r.bandes.map(b => ok(b) ? b.il - b.sigma : NaN), couleur: "#b48cc0", tirets: [5, 4], sansLegende: true });
    }
    // bandes limitées par le bruit de fond : valeur minorée, raccordée aux
    // bandes voisines pour rester visible même isolée
    const minoree = r.bandes.map((b, i) => {
      const estM = (j) => r.bandes[j] && r.bandes[j].statut === "minorée";
      return (estM(i) || estM(i - 1) || estM(i + 1)) && b.statut !== "inexploitable" ? b.il : NaN;
    });
    if (r.bandes.some(b => b.statut === "minorée")) series.push({ xs, ys: minoree, couleur: "#9aa0a8", tirets: [2, 3], label: "limitée par le bruit de fond (au moins)" });
    tracerCourbe(canvas, series, Object.assign({
      titre: "Atténuation par tiers d'octave : [réf. − micro] avec casque − [réf. − micro] sans casque",
      ylabel: "atténuation (dB)", lignesH: [{ y: 0, couleur: "#20242b" }], etendueMinY: 10,
    }, optsHz));
  }, () => `${base}_attenuation.png`));

  zone.appendChild(casqueTableau(r));

  const actions = casqueEl("div", "no-print");
  const btnCsv = casqueEl("button", "secondaire", "Télécharger le tableau (CSV)");
  btnCsv.type = "button"; btnCsv.id = "casqueCsv";
  btnCsv.addEventListener("click", () => casqueTelechargerCsv(r));
  const btnPdf = casqueEl("button", "secondaire", "Imprimer / enregistrer en PDF");
  btnPdf.type = "button"; btnPdf.style.marginLeft = ".6rem";
  btnPdf.addEventListener("click", () => window.print());
  actions.append(btnCsv, btnPdf);
  zone.appendChild(actions);
}

function casqueTableau(r) {
  const t = document.createElement("table");
  t.className = "pat-table casque-table";
  t.id = "casqueTableau";
  const colRef = r.vRef >= 0;
  let html = `<thead><tr><th>Bande (Hz)</th><th>Micro sans casque (${r.uniteMic})</th><th>Micro avec casque (${r.uniteMic})</th>` +
    (colRef ? `<th>Écart de la référence avec − sans (dB)</th>` : "") +
    `<th>Atténuation (dB)</th><th>Écart-type (dB)</th><th>Min / max (dB)</th><th>Bruit de fond</th></tr></thead><tbody>`;
  for (const b of r.bandes) {
    const inex = b.statut === "inexploitable";
    const il = inex ? "—" : `${b.statut === "minorée" ? "≥ " : ""}${casqueFormat(b.il, 1)}`;
    const statut = b.statut === "ok" ? "ok (≥ 10 dB)" :
      b.statut === "minorée" ? `micro sous casque à ${casqueFormat(b.ecartAvec, 1)} dB du fond : valeur minorée` :
      b.statut === "inexploitable" ? "inexploitable : sans casque ou référence à moins de 10 dB du fond" : "non vérifié";
    html += `<tr data-fc="${b.fc}" data-statut="${b.statut}"><td>${formatHz(b.fc)}</td><td>${casqueFormat(b.micSans, 1)}</td><td>${casqueFormat(b.micAvec, 1)}</td>` +
      (colRef ? `<td>${casqueFormat(b.refAvec - b.refSans, 1)}</td>` : "") +
      `<td>${il}</td><td>${inex ? "—" : casqueFormat(b.sigma, 1)}</td><td>${inex ? "—" : casqueFormat(b.ilMin, 1) + " / " + casqueFormat(b.ilMax, 1)}</td><td>${statut}</td></tr>`;
  }
  t.innerHTML = html + "</tbody>";
  return t;
}

function casqueTelechargerCsv(r) {
  const entete = ["bande_Hz", `micro_sans_${r.uniteMic.replace(" ", "_")}`, `micro_avec_${r.uniteMic.replace(" ", "_")}`];
  if (r.vRef >= 0) entete.push(`ref_sans_${r.uniteRef.replace(" ", "_")}`, `ref_avec_${r.uniteRef.replace(" ", "_")}`);
  if (r.avecFond) entete.push("micro_fond", "ref_fond");
  entete.push("attenuation_moyenne_dB", "ecart_type_dB", ...r.poses.map((_, i) => `attenuation_pose${i + 1}_dB`), "statut_bruit_de_fond");
  const f = (v) => isFinite(v) ? v.toFixed(2) : "";
  const lignes = [entete.join(";")];
  for (const b of r.bandes) {
    const l = [b.fc, f(b.micSans), f(b.micAvec)];
    if (r.vRef >= 0) l.push(f(b.refSans), f(b.refAvec));
    if (r.avecFond) l.push(f(b.micFond), f(b.refFond));
    l.push(f(b.il), f(b.sigma), ...b.ilPoses.map(f), b.statut);
    lignes.push(l.join(";"));
  }
  lignes.push("");
  lignes.push(`# micro sous le casque;${nomVoie(r.vMic)};reference;${r.vRef >= 0 ? nomVoie(r.vRef) : "aucune"};marge_s;${r.margeS}`);
  lignes.push(`# poses;${r.poses.join(";")}`);
  lignes.push(`# attenuation globale bruit rose dB(A);${r.dLAminore ? ">=" : ""}${f(r.dLA)}`);
  const blob = new Blob(["﻿" + lignes.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "casque_attenuation.csv";
  a.click();
}

casqueInitialiser();
