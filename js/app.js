"use strict";
/* =========================================================================
   APP.JS — etat applicatif, depot de fichiers, onglets (Voie 1-4,
   Comparaison, Parametres du capteur), controles FFT interactifs, exports.

   Numerotation : l'indexation interne des voies reste en base 0 (comme
   dans dsp.js), seul l'affichage (titres, tableaux, noms de fichiers
   exportes) montre 1 a 4. Voir nomVoie().
   ========================================================================= */

function nomVoie(i) { return `Voie ${i+1}`; }

let wavData = null, txtTexte = null;
let calibration = null;
let resultatsBase = [];      // par voie : grandeurs independantes des parametres FFT
let fftParams = null;        // { nperseg, recouvrement, fenetre }, partage entre les 4 voies
let cachePsd = new Map();
let cacheStft = new Map();
let ongletActif = "voie0";
let dernierVoieActive = 0;
let comparaisonSelection = [true, true, true, true];
let voieCourbeCapteur = null;

function baseNomFichier() { return wavData.nomFichier.replace(/\.wav$/i, ""); }

/* ---------------------------------------------------------- depot fichiers */
function configurerZoneDepot(dropId, inputId, nomId, onFichier) {
  const drop = document.getElementById(dropId), input = document.getElementById(inputId), nom = document.getElementById(nomId);
  drop.addEventListener("click", ()=>input.click());
  drop.addEventListener("dragover", e=>{ e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", ()=>drop.classList.remove("over"));
  drop.addEventListener("drop", e=>{
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; onFichier(e.dataTransfer.files[0]); nom.textContent = e.dataTransfer.files[0].name; }
  });
  input.addEventListener("change", ()=>{ if (input.files.length) { onFichier(input.files[0]); nom.textContent = input.files[0].name; } });
}

configurerZoneDepot("dropWav","inputWav","nomWav", async (fichier)=>{
  const buf = await fichier.arrayBuffer();
  try {
    wavData = lireWav(buf);
    wavData.nomFichier = fichier.name;
    document.getElementById("btnAnalyser").disabled = false;
  } catch(err) {
    alert("Erreur de lecture du fichier WAV : " + err.message);
    wavData = null;
  }
});

configurerZoneDepot("dropTxt","inputTxt","nomTxt", async (fichier)=>{
  txtTexte = await fichier.text();
});

document.getElementById("btnAnalyser").addEventListener("click", ()=>{
  if (!wavData) return;
  calibration = lireCalibration(txtTexte);
  demarrerAnalyse();
});

/* ==================================================================== analyse */
function demarrerAnalyse() {
  cachePsd.clear(); cacheStft.clear();
  resultatsBase = [];
  for (let v = 0; v < wavData.nCh; v++) {
    const spl = calibration[v];
    const calibre = spl !== null && spl !== undefined;
    const pref = calibre ? PREF : 1.0;
    const gain = calibre ? PREF*Math.pow(10, spl/20) : 1.0;
    const pression = wavData.canaux[v].map(x=>x*gain);

    const sigA = lfilter(B_A, A_A, pression);
    const sigC = lfilter(B_C, A_C, pression);

    resultatsBase.push({
      voie: v, calibre, pref, pression,
      leqA: leq(sigA, pref), leqC: leq(sigC, pref), leqZ: leq(pression, pref),
      lafmax: lmaxFast(sigA, wavData.fs, pref), lcpeak: lpeak(sigC, pref),
      temporel: niveauTemporel(sigA, wavData.fs, pref, 1.0),
    });
  }

  fftParams = parametresFftParDefaut(wavData.fs, resultatsBase[0].pression.length);
  voieCourbeCapteur = null;
  ongletActif = "voie0"; dernierVoieActive = 0;
  comparaisonSelection = resultatsBase.map(()=>true);

  construireInterface();
}

function uniteCourante() {
  return resultatsBase.some(r=>r.calibre) ? "dB SPL" : "dBFS (non calibré)";
}

/* -------------------------------------------------------- acces aux resultats FFT (caches) */
function cleFft() { return `${fftParams.nperseg}|${fftParams.recouvrement}|${fftParams.fenetre}`; }

// Les resultats mis en cache (spectres, spectrogrammes) peuvent contenir de
// gros tableaux ; on limite le nombre de combinaisons (voie, parametres FFT)
// conservees simultanement pour ne pas laisser la memoire croitre sans fin
// au fil d'une session ou l'utilisateur explore plusieurs reglages.
const CACHE_TAILLE_MAX = 16;
function mettreEnCache(map, cle, valeur) {
  if (map.size >= CACHE_TAILLE_MAX) map.delete(map.keys().next().value);
  map.set(cle, valeur);
  return valeur;
}

function obtenirPsd(v) {
  const cle = v + "|" + cleFft();
  if (cachePsd.has(cle)) return cachePsd.get(cle);
  const { freqs, psd, df } = calculerPsd(resultatsBase[v].pression, wavData.fs, fftParams);
  const psdCorrige = new Float64Array(psd.length);
  for (let k = 0; k < psd.length; k++) psdCorrige[k] = psd[k] * Math.pow(10, -correctionMicroDb(freqs[k])/10);
  const bandesA = tiersOctave(freqs, psdCorrige, df, "A");
  return mettreEnCache(cachePsd, cle, { freqs, psdBrut: psd, psdCorrige, df, bandesA });
}

function obtenirStft(v) {
  const cle = v + "|" + cleFft();
  if (cacheStft.has(cle)) return cacheStft.get(cle);
  return mettreEnCache(cacheStft, cle, calculerStft(resultatsBase[v].pression, wavData.fs, fftParams));
}

function psdEnDb(psd, pref) {
  const pref2 = pref*pref;
  return Array.from(psd).map(v => 10*Math.log10(Math.max(v,1e-24)/pref2));
}

/* ============================================================ construction UI */
function construireInterface() {
  const zone = document.getElementById("zoneResultats");
  zone.innerHTML = "";
  zone.appendChild(construirePanelSynthese());

  const nav = document.createElement("div");
  nav.className = "tabs no-print";
  nav.id = "tabsNav";
  zone.appendChild(nav);

  const contenu = document.createElement("div");
  contenu.id = "tabsContenu";
  zone.appendChild(contenu);

  const onglets = [];
  for (let v = 0; v < wavData.nCh; v++) onglets.push({ id: `voie${v}`, label: nomVoie(v) });
  onglets.push({ id: "comparaison", label: "Comparaison" });
  onglets.push({ id: "capteur", label: "Paramètres du capteur" });

  for (const o of onglets) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = o.label; btn.dataset.onglet = o.id;
    btn.addEventListener("click", ()=>activerOnglet(o.id));
    nav.appendChild(btn);

    const div = document.createElement("div");
    div.className = "onglet-contenu"; div.id = `contenu-${o.id}`;
    contenu.appendChild(div);
  }

  activerOnglet(ongletActif);
}

function activerOnglet(id) {
  ongletActif = id;
  if (id.startsWith("voie")) dernierVoieActive = parseInt(id.slice(4), 10);
  document.querySelectorAll("#tabsNav button").forEach(b=>b.classList.toggle("actif", b.dataset.onglet===id));
  document.querySelectorAll(".onglet-contenu").forEach(d=>d.classList.toggle("actif", d.id===`contenu-${id}`));

  const conteneur = document.getElementById(`contenu-${id}`);
  if (id.startsWith("voie")) rendreOngletVoie(parseInt(id.slice(4),10), conteneur);
  else if (id === "comparaison") rendreOngletComparaison(conteneur);
  else if (id === "capteur") rendreOngletCapteur(conteneur);
}

function rafraichirOngletActif() { activerOnglet(ongletActif); }

/* ----------------------------------------------------------- controles FFT */
function creerControlesFft(maxLen) {
  const div = document.createElement("div");
  div.className = "fft-controles no-print";

  const optsTaille = TAILLES_FFT_DISPONIBLES.filter(t => t <= pow2Below(maxLen));

  function creerSelect(label, options, valeur, onChange) {
    const wrap = document.createElement("label");
    wrap.textContent = label;
    const sel = document.createElement("select");
    for (const [v, texte] of options) {
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = texte;
      if (String(v) === String(valeur)) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", ()=>onChange(sel.value));
    wrap.appendChild(sel);
    return wrap;
  }

  div.appendChild(creerSelect("Taille de fenêtre (échantillons)",
    optsTaille.map(t=>[t, t]), fftParams.nperseg,
    v => { fftParams.nperseg = parseInt(v,10); rafraichirOngletActif(); }));

  div.appendChild(creerSelect("Recouvrement",
    [[0,"0 %"],[25,"25 %"],[50,"50 %"],[75,"75 %"],[90,"90 %"]], fftParams.recouvrement,
    v => { fftParams.recouvrement = parseInt(v,10); rafraichirOngletActif(); }));

  div.appendChild(creerSelect("Type de fenêtre",
    [["hann","Hann"],["hamming","Hamming"],["rect","Rectangulaire"]], fftParams.fenetre,
    v => { fftParams.fenetre = v; rafraichirOngletActif(); }));

  const note = document.createElement("div");
  note.className = "note";
  note.textContent = `Résolution fréquentielle : ${(wavData.fs/Math.min(fftParams.nperseg, pow2Below(maxLen))).toFixed(2)} Hz/raie. S'applique au spectre en bande fine, aux tiers d'octave et au spectrogramme, pour les quatre voies.`;
  div.appendChild(note);

  return div;
}

/* ---------------------------------------------------------------- onglet voie */
function rendreOngletVoie(v, conteneur) {
  const r = resultatsBase[v];
  const unite = uniteCourante();
  conteneur.innerHTML = "";
  conteneur.appendChild(creerControlesFft(r.pression.length));

  const cartes = document.createElement("div");
  cartes.className = "synthese-niveaux";
  const items = [
    ["OASPL", r.leqZ], ["LAeq", r.leqA], ["LCeq", r.leqC], ["LCpeak", r.lcpeak], ["LAFmax", r.lafmax],
  ];
  cartes.innerHTML = items.map(([label,val])=>`<div class="carte"><div class="valeur">${isFinite(val)?val.toFixed(1):"—"}</div><div class="label">${label} (${unite})</div></div>`).join("");
  conteneur.appendChild(cartes);

  const { freqs, psdCorrige, bandesA } = obtenirPsd(v);
  const stft = obtenirStft(v);

  conteneur.appendChild(creerBlocGraphique(`temps-${v}`, "Évolution du niveau dans le temps, dB(A), fenêtres de 1 s", (canvas)=>{
    tracerCourbe(canvas, [{ xs: r.temporel.temps, ys: r.temporel.niveaux, couleur: PALETTE_VOIES[v] }],
      { titre: "Évolution du niveau dans le temps, dB(A), fenêtres de 1 s", xlabel: "temps (s)", ylabel: `niveau (${unite})` });
  }, () => `${baseNomFichier()}_voie${v+1}_temporel.png`));

  conteneur.appendChild(creerBlocGraphique(`spectre-${v}`, "Spectre en bande fine (corrigé de la réponse du capteur)", (canvas)=>{
    tracerCourbe(canvas, [{ xs: Array.from(freqs), ys: psdEnDb(psdCorrige, r.pref), couleur: PALETTE_VOIES[v] }],
      { titre: "Spectre en bande fine (corrigé de la réponse du capteur)", xlabel: "fréquence (Hz)", ylabel: `niveau (${unite})`, logX: true, xMin: 20, xMax: wavData.fs/2, formatX: formatHz });
  }, () => `${baseNomFichier()}_voie${v+1}_spectre.png`));

  conteneur.appendChild(creerBlocGraphique(`bandes-${v}`, "Tiers d'octave, pondéré A, corrigé de la réponse du capteur", (canvas)=>{
    tracerBarres(canvas, FREQ_TIERS_OCTAVE, bandesA, { titre: "Tiers d'octave, pondéré A, corrigé de la réponse du capteur" });
  }, () => `${baseNomFichier()}_voie${v+1}_tiers-octave.png`));

  conteneur.appendChild(creerBlocGraphique(`spectro-${v}`, "Spectrogramme (corrigé de la réponse du capteur)", (canvas)=>{
    tracerSpectrogramme(canvas, Array.from(stft.freqs), stft.temps, stft.trames,
      { titre: "Spectrogramme (corrigé de la réponse du capteur)", correctionDb: correctionMicroDb, fMax: wavData.fs/2 });
  }, () => `${baseNomFichier()}_voie${v+1}_spectrogramme.png`, "spectrogramme"));
}

function creerBlocGraphique(idBase, titre, dessiner, nomFichierFn, classeSupp) {
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "chart" + (classeSupp ? " " + classeSupp : "");
  canvas.id = `c-${idBase}`;
  wrap.appendChild(canvas);
  wrap.appendChild(boutonExportCanvas(canvas, nomFichierFn));
  // dessin differe : le canvas doit deja etre dans le DOM (visible) pour avoir une largeur/hauteur
  requestAnimationFrame(()=>dessiner(canvas));
  return wrap;
}

/* ---------------------------------------------------------- onglet comparaison */
function rendreOngletComparaison(conteneur) {
  conteneur.innerHTML = "";
  conteneur.appendChild(creerControlesFft(resultatsBase[0].pression.length));

  const cases = document.createElement("div");
  cases.className = "cases-voies";
  for (let v = 0; v < wavData.nCh; v++) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = comparaisonSelection[v];
    cb.addEventListener("change", ()=>{ comparaisonSelection[v] = cb.checked; rafraichirOngletActif(); });
    const pastille = document.createElement("span");
    pastille.className = "pastille"; pastille.style.background = PALETTE_VOIES[v];
    label.appendChild(cb); label.appendChild(pastille); label.appendChild(document.createTextNode(nomVoie(v)));
    cases.appendChild(label);
  }
  conteneur.appendChild(cases);

  const unite = uniteCourante();
  const series = [];
  for (let v = 0; v < wavData.nCh; v++) {
    if (!comparaisonSelection[v]) continue;
    const { freqs, psdCorrige } = obtenirPsd(v);
    series.push({ xs: Array.from(freqs), ys: psdEnDb(psdCorrige, resultatsBase[v].pref), couleur: PALETTE_VOIES[v], label: nomVoie(v) });
  }

  conteneur.appendChild(creerBlocGraphique("comparaison-spectre",
    "Comparaison des spectres en bande fine, 4 voies",
    (canvas)=>{
      if (!series.length) { const {ctx,w,h} = preparerCanvas(canvas); ctx.clearRect(0,0,w,h); ctx.fillStyle="#5b6270"; ctx.font="13px sans-serif"; ctx.fillText("Sélectionnez au moins une voie ci-dessus.", 20, 30); return; }
      tracerCourbe(canvas, series, { titre: "Comparaison des spectres en bande fine, 4 voies", xlabel: "fréquence (Hz)", ylabel: `niveau (${unite})`, logX: true, xMin: 20, xMax: wavData.fs/2, formatX: formatHz });
    },
    () => `${baseNomFichier()}_comparaison-spectre.png`));
}

/* ------------------------------------------------------------- onglet capteur */
function rendreOngletCapteur(conteneur) {
  if (voieCourbeCapteur === null) voieCourbeCapteur = dernierVoieActive;
  conteneur.innerHTML = "";

  const panelCal = document.createElement("div");
  let lignes = "";
  for (let v = 0; v < wavData.nCh; v++) {
    const spl = calibration[v];
    const ok = spl !== null && spl !== undefined;
    lignes += `<tr><td>${nomVoie(v)}</td><td>${ok ? spl.toFixed(1)+" dB" : "—"}</td><td>${ok ? "Étalonnée" : "<strong>Non étalonnée</strong> (dBFS relatif)"}</td></tr>`;
  }
  panelCal.innerHTML = `<h3>Constantes d'étalonnage (SPL pleine échelle, lues dans le .TXT)</h3>
    <table><thead><tr><th>Voie</th><th>SPL_pleine_echelle</th><th>État</th></tr></thead><tbody>${lignes}</tbody></table>`;
  conteneur.appendChild(panelCal);

  conteneur.appendChild(creerBlocGraphique("courbe-micro",
    "Réponse en fréquence typique du microphone MP23ABS1",
    (canvas)=>{
      tracerCourbe(canvas, [{ xs: COURBE_MICRO_HZ, ys: COURBE_MICRO_DB, couleur: "#0f4c5c" }],
        { titre: "Réponse en fréquence typique du microphone MP23ABS1", xlabel: "fréquence (Hz)", ylabel: "écart (dB)", logX: true, xMin: 20, xMax: 20000, formatX: formatHz });
    },
    () => `courbe-micro-mp23abs1.png`));

  const note = document.createElement("p");
  note.className = "avertissement";
  note.textContent = "Courbe typique fournie par le fabricant du microphone MP23ABS1, pas une mesure individuelle de chaque capteur du boîtier. Elle sert à corriger le spectre en bande fine et les tiers d'octave affichés dans chaque onglet Voie ; les niveaux globaux (LAeq, LCpeak, OASPL) ne sont pas corrigés par cette courbe.";
  conteneur.appendChild(note);

  const selWrap = document.createElement("div");
  selWrap.className = "fft-controles no-print";
  const label = document.createElement("label");
  label.textContent = "Voie affichée ci-dessous";
  const sel = document.createElement("select");
  for (let v = 0; v < wavData.nCh; v++) {
    const opt = document.createElement("option"); opt.value = v; opt.textContent = nomVoie(v);
    if (v === voieCourbeCapteur) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", ()=>{ voieCourbeCapteur = parseInt(sel.value,10); rafraichirOngletActif(); });
  label.appendChild(sel); selWrap.appendChild(label);
  conteneur.appendChild(selWrap);

  const v = voieCourbeCapteur;
  const { freqs, psdBrut, psdCorrige } = obtenirPsd(v);
  const unite = uniteCourante();
  const pref = resultatsBase[v].pref;
  conteneur.appendChild(creerBlocGraphique(`capteur-overlay-${v}`,
    `Effet de la correction de réponse du capteur — ${nomVoie(v)}`,
    (canvas)=>{
      tracerCourbe(canvas, [
        { xs: Array.from(freqs), ys: psdEnDb(psdBrut, pref), couleur: "#9aa0a8", tirets: [5,3], label: "Brut (non corrigé)" },
        { xs: Array.from(freqs), ys: psdEnDb(psdCorrige, pref), couleur: PALETTE_VOIES[v], label: "Corrigé (réponse du capteur)" },
      ], { titre: `Effet de la correction de réponse du capteur — ${nomVoie(v)}`, xlabel: "fréquence (Hz)", ylabel: `niveau (${unite})`, logX: true, xMin: 20, xMax: wavData.fs/2, formatX: formatHz });
    },
    () => `${baseNomFichier()}_voie${v+1}_brut-vs-corrige.png`));
}

/* -------------------------------------------------------------- synthese + export */
function construirePanelSynthese() {
  const unite = uniteCourante();
  const uneCalibree = resultatsBase.some(r=>r.calibre);
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<h2>Synthèse — ${wavData.nomFichier}</h2>` +
    (uneCalibree ? "" : `<div class="avertissement">Étalonnage non renseigné pour au moins une voie : les niveaux affichés sont en dBFS relatif, pas en dB SPL absolu.</div>`) +
    `<table><thead><tr><th>Voie</th><th>OASPL (${unite})</th><th>LAeq (${unite})</th><th>LCeq (${unite})</th><th>LCpeak (${unite})</th><th>LAFmax (${unite})</th></tr></thead><tbody>` +
    resultatsBase.map(r=>`<tr><td>${nomVoie(r.voie)}</td><td>${r.leqZ.toFixed(1)}</td><td>${r.leqA.toFixed(1)}</td><td>${r.leqC.toFixed(1)}</td><td>${r.lcpeak.toFixed(1)}</td><td>${r.lafmax.toFixed(1)}</td></tr>`).join("") +
    `</tbody></table>
     <dl class="lexique" style="margin-top:.8rem;">
       <dt>OASPL</dt><dd>niveau global non pondéré (linéaire), sur toute la durée.</dd>
       <dt>LAeq</dt><dd>niveau moyen en dB(A) sur toute la durée, la référence pour une exposition sonore.</dd>
       <dt>LCeq</dt><dd>niveau moyen en dB(C) sur toute la durée.</dd>
       <dt>LCpeak</dt><dd>niveau de crête en dB(C), pour un événement bref et fort.</dd>
       <dt>LAFmax</dt><dd>niveau maximal en dB(A), intégration rapide (125 ms).</dd>
     </dl>
     <button class="secondaire no-print" id="btnCsv">Télécharger le tableau (CSV)</button>
     <button class="secondaire no-print" id="btnPdf" style="margin-left:.6rem;">Imprimer / enregistrer en PDF</button>`;

  requestAnimationFrame(()=>{
    document.getElementById("btnCsv").addEventListener("click", ()=>telechargerCsv());
    document.getElementById("btnPdf").addEventListener("click", ()=>window.print());
  });
  return panel;
}

function telechargerCsv() {
  const unite = uniteCourante();
  let csv = `voie,calibre,OASPL (${unite}),LAeq (${unite}),LCeq (${unite}),LAFmax (${unite}),LCpeak (${unite}),duree_s\n`;
  for (const r of resultatsBase) {
    csv += `${nomVoie(r.voie)},${r.calibre?"oui":"non"},${r.leqZ.toFixed(2)},${r.leqA.toFixed(2)},${r.leqC.toFixed(2)},${r.lafmax.toFixed(2)},${r.lcpeak.toFixed(2)},${wavData.dureeS.toFixed(2)}\n`;
  }
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = baseNomFichier() + "_resultats.csv";
  a.click();
}
