"use strict";
/* =========================================================================
   APP.JS — etat applicatif, depot de fichiers, onglets (Voie 1-4,
   Comparaison, Parametres du capteur), controles FFT interactifs, exports.

   Numerotation : l'indexation interne des voies reste en base 0 (comme
   dans dsp.js), seul l'affichage (titres, tableaux, noms de fichiers
   exportes) montre 1 a 4. Voir nomVoie().
   ========================================================================= */

// Numero de version affiche en pied de page (pas d'etape de build dans cet
// outil : a incrementer ICI a la main a chaque evolution notable, avec la
// date du jour). Seule constante a modifier pour changer l'indicateur.
const VERSION_OUTIL = "v1.6 — 27 sept. 2026";
document.getElementById("pieDeVersion").textContent = VERSION_OUTIL;

function nomVoie(i) { return `Voie ${i+1}`; }

// Badge de statut de calibration (point 5), visible directement sur
// l'onglet de chaque voie : repere d'un coup d'oeil, sans naviguer vers
// "Paramètres du capteur", si les niveaux affiches sont en dB SPL absolu
// fiable ou en dBFS relatif. Couleur ET texte portent l'information (pas
// la couleur seule).
function creerBadgeCalibration(calibre) {
  const badge = document.createElement("span");
  badge.className = "badge-cal " + (calibre ? "calibre" : "non-calibre");
  badge.textContent = calibre ? "dB SPL" : "dBFS";
  badge.title = calibre
    ? "Voie étalonnée : niveaux en dB SPL absolu."
    : "Voie non étalonnée : niveaux en dBFS relatif, pas de dB SPL absolu fiable.";
  return badge;
}

let wavData = null, txtTexte = null;
let calibration = null;
let resultatsBase = [];      // par voie : grandeurs independantes des parametres FFT
                              // tableau creux : resultatsBase[v] n'existe que si la voie v a
                              // ete cochee dans le panneau "Voies a analyser" (voir voiesSelectionnees
                              // ci-dessous) ET effectivement analysee ; une voie decochee n'a
                              // aucune entree ici, cf. voiesAnalysees().
let fftParams = null;        // { nperseg, recouvrement, fenetre }, partage entre les voies analysees
let cachePsd = new Map();
let cacheStft = new Map();
let ongletActif = "voie0";
let dernierVoieActive = 0;
let comparaisonSelection = [true, true, true, true];
let voieCourbeCapteur = null;

// Voies cochees dans le panneau "Voies a analyser" (page d'accueil, avant de
// cliquer sur "Analyser") : voiesSelectionnees[v] = true/false, une entree
// par voie reellement presente dans le fichier (wavData.nCh), reinitialisee
// a tout coche a chaque nouveau depot de WAV (construireSelectionVoies).
let voiesSelectionnees = [];

function baseNomFichier() { return wavData.nomFichier.replace(/\.wav$/i, ""); }

/* baseName sans extension, pour comparer les noms de fichiers WAV et TXT */
function baseNomSansExt(nom) { return nom.replace(/\.[^.]+$/, ""); }

/* Liste des indices de voies effectivement analysees (resultatsBase[v]
   existe) : a utiliser partout ou l'on parcourait auparavant 0..wavData.nCh-1
   en supposant que toutes les voies avaient ete calculees (onglets,
   impression, export CSV, selecteur de l'onglet capteur...), maintenant
   qu'une voie decochee n'a pas d'entree dans resultatsBase. */
function voiesAnalysees() {
  const arr = [];
  for (let v = 0; v < wavData.nCh; v++) if (resultatsBase[v]) arr.push(v);
  return arr;
}

// Duree d'un fichier audio, format court pour la confirmation de depot
// ("12 min 34 s" ou "45 s" si moins d'une minute).
function formatDureeCourte(s) {
  const total = Math.round(s);
  const m = Math.floor(total / 60), sec = total % 60;
  return m > 0 ? `${m} min ${sec} s` : `${sec} s`;
}

/* ---------------------------------------------------------- depot fichiers */
function afficherAvertissementDepot(texte) {
  const div = document.getElementById("avertDepot");
  if (!texte) { div.style.display = "none"; div.textContent = ""; return; }
  div.style.display = ""; div.textContent = texte;
}

async function traiterFichiers(liste) {
  const fichiers = Array.from(liste);
  const fichierWav = fichiers.find(f => /\.wav$/i.test(f.name));
  const fichierTxt = fichiers.find(f => /\.txt$/i.test(f.name));
  const inconnus = fichiers.filter(f => f !== fichierWav && f !== fichierTxt);

  let avertissement = "";
  if (inconnus.length) {
    avertissement = `Fichier(s) ignoré(s), extension non reconnue : ${inconnus.map(f=>f.name).join(", ")}.`;
  }

  // Retour immediat au depot (avant meme la lecture, potentiellement longue
  // sur un fichier volumineux) : reutilise le message de statut existant
  // (statutAnalyse), pas de barre de progression ici — la lecture d'un WAV,
  // meme volumineux, reste de l'ordre de la seconde (mesuree lors de la
  // session precedente sur un fichier de 25 min), un simple message suffit.
  const statut = document.getElementById("statutAnalyse");

  if (fichierWav) {
    statut.textContent = `Lecture de ${fichierWav.name}…`;
    const buf = await fichierWav.arrayBuffer();
    try {
      wavData = lireWav(buf);
      wavData.nomFichier = fichierWav.name;
      document.getElementById("nomWav").textContent =
        `Audio : ${fichierWav.name} (${formatDureeCourte(wavData.dureeS)}, ${wavData.nCh} voie${wavData.nCh>1?"s":""}, ${wavData.fs} Hz)`;
      construireSelectionVoies();
    } catch(err) {
      alert("Erreur de lecture du fichier WAV : " + err.message);
      wavData = null;
      document.getElementById("nomWav").textContent = "";
      masquerSelectionVoies();
    } finally {
      statut.textContent = "";
    }
  }

  if (fichierTxt) {
    statut.textContent = `Lecture de ${fichierTxt.name}…`;
    txtTexte = await fichierTxt.text();
    document.getElementById("nomTxt").textContent = "Métadonnées : " + fichierTxt.name;
    statut.textContent = "";
  }

  if (fichierWav && fichierTxt && baseNomSansExt(fichierWav.name) !== baseNomSansExt(fichierTxt.name)) {
    avertissement = (avertissement ? avertissement + " " : "") +
      `Attention : les noms de fichiers ne correspondent pas (${fichierWav.name} / ${fichierTxt.name}). Le WAV est chargé quand même.`;
  }
  afficherAvertissementDepot(avertissement);
}

/* ------------------------------------------------------ selection des voies */
// Ecart (en dB) en-dessous duquel une voie cochee est signalee comme
// anormalement faible par rapport a la moyenne des autres voies cochees
// (indice de micro debranche/mal connecte, cf. maquette) : jamais une
// decoche automatique, seulement un signal visuel, la decision reste a
// l'utilisatrice.
const SEUIL_NIVEAU_FAIBLE_DB = 15;

// Niveau global "rapide" d'une voie, sans filtrage ni etalonnage (juste le
// RMS du signal brut, cf. leq() dans dsp.js) : sert uniquement a detecter
// une voie anormalement faible avant l'analyse complete, a un cout
// negligeable (un seul passage sur le signal, aucun filtrage IIR).
function niveauxRapidesParVoie() {
  return wavData.canaux.map(canal => leq(canal, 1.0));
}

// Pour chaque voie cochee, compare son niveau rapide a la moyenne des autres
// voies cochees ; renvoie un tableau de booleens (indexe comme wavData.nCh).
// Necessite au moins deux voies cochees pour qu'une comparaison ait un sens.
function calculerAvertissementsNiveaux(niveaux) {
  const avert = wavData.canaux.map(() => false);
  const cochees = [];
  for (let v = 0; v < wavData.nCh; v++) if (voiesSelectionnees[v]) cochees.push(v);
  if (cochees.length < 2) return avert;
  for (const v of cochees) {
    const autres = cochees.filter(w => w !== v).map(w => niveaux[w]);
    const moyenneAutres = autres.reduce((a,b)=>a+b, 0) / autres.length;
    if (niveaux[v] < moyenneAutres - SEUIL_NIVEAU_FAIBLE_DB) avert[v] = true;
  }
  return avert;
}

function construireSelectionVoies() {
  voiesSelectionnees = wavData.canaux.map(() => true);
  document.getElementById("panelSelectionVoies").style.display = "";
  rendreSelectionVoies();
}

function masquerSelectionVoies() {
  const panel = document.getElementById("panelSelectionVoies");
  panel.style.display = "none";
  panel.innerHTML = "";
  voiesSelectionnees = [];
  mettreAJourBoutonAnalyser();
}

function mettreAJourBoutonAnalyser() {
  const bouton = document.getElementById("btnAnalyser");
  const n = voiesSelectionnees.filter(Boolean).length;
  if (!wavData) { bouton.textContent = "Analyser"; bouton.disabled = true; return; }
  bouton.textContent = n > 0 ? `Analyser (${n} voie${n>1?"s":""} sélectionnée${n>1?"s":""})` : "Analyser";
  bouton.disabled = n === 0;
}

function rendreSelectionVoies() {
  const panel = document.getElementById("panelSelectionVoies");
  panel.innerHTML = "";

  const titre = document.createElement("h2");
  titre.textContent = "2. Voies à analyser";
  panel.appendChild(titre);

  const explication = document.createElement("p");
  explication.style.cssText = "color:var(--ink-soft); font-size:.9rem; margin:0 0 1rem;";
  explication.textContent = "Décochez une voie si vous savez qu'aucun micro n'y était branché sur cet enregistrement : elle ne sera pas calculée, ce qui accélère l'analyse.";
  panel.appendChild(explication);

  const niveaux = niveauxRapidesParVoie();
  const avert = calculerAvertissementsNiveaux(niveaux);

  const grille = document.createElement("div");
  grille.className = "voies-selection";
  for (let v = 0; v < wavData.nCh; v++) {
    const carte = document.createElement("div");
    carte.className = "voie-select-carte" + (avert[v] ? " avertissement-carte" : "");

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = voiesSelectionnees[v];
    cb.addEventListener("change", () => {
      voiesSelectionnees[v] = cb.checked;
      rendreSelectionVoies();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${nomVoie(v)} (micro ${v+1})`));
    carte.appendChild(label);

    if (avert[v]) {
      const badge = document.createElement("div");
      badge.className = "badge-niveau-faible";
      badge.textContent = "⚠ signal anormalement faible";
      carte.appendChild(badge);
    }

    grille.appendChild(carte);
  }
  panel.appendChild(grille);

  const voiesFaibles = [];
  for (let v = 0; v < wavData.nCh; v++) if (avert[v]) voiesFaibles.push(nomVoie(v));
  if (voiesFaibles.length) {
    const msg = document.createElement("div");
    msg.className = "avertissement";
    msg.textContent = `${voiesFaibles.join(", ")} ${voiesFaibles.length>1?"ont":"a"} un niveau nettement plus faible que les autres voies cochées sur cet enregistrement — micro débranché, mal connecté, ou panne possible. Vérifiez avant de l'inclure dans l'analyse.`;
    panel.appendChild(msg);
  }

  mettreAJourBoutonAnalyser();
}

function configurerZoneDepot() {
  const drop = document.getElementById("dropFichiers"), input = document.getElementById("inputFichiers");
  drop.addEventListener("click", ()=>input.click());
  drop.addEventListener("dragover", e=>{ e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", ()=>drop.classList.remove("over"));
  drop.addEventListener("drop", e=>{
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files.length) traiterFichiers(e.dataTransfer.files);
  });
  input.addEventListener("change", ()=>{
    if (input.files.length) traiterFichiers(input.files);
    input.value = "";
  });
}
configurerZoneDepot();

document.getElementById("btnAnalyser").addEventListener("click", async ()=>{
  if (!wavData || !voiesSelectionnees.some(Boolean)) return;
  calibration = lireCalibration(txtTexte);
  const bouton = document.getElementById("btnAnalyser");
  bouton.disabled = true;
  // try/finally : si demarrerAnalyse echoue (fichier tres volumineux,
  // memoire insuffisante...), le bouton doit rester utilisable pour
  // reessayer plutot que de bloquer l'interface (point 3, garde-fou).
  try { await demarrerAnalyse(); } finally { bouton.disabled = false; }
});

function attendreProchaineImage() { return new Promise(r => requestAnimationFrame(r)); }

// Pause reelle (macrotache), utilisee pendant les calculs decoupes en
// tranches (lfilterAsync, calculerSegmentsFftAsync) : contrairement a
// requestAnimationFrame (qui attend le prochain repaint), setTimeout(...,0)
// laisse aussi le navigateur traiter les evenements en attente (clic sur un
// autre onglet, redimensionnement...) entre deux tranches de calcul.
function cederAuNavigateur() { return new Promise(r => setTimeout(r, 0)); }

/* -------------------------------------------------------------- barre de progression */
function afficherBarreProgression() {
  document.getElementById("barreProgressionConteneur").style.display = "";
}
function masquerBarreProgression() {
  document.getElementById("barreProgressionConteneur").style.display = "none";
}
function mettreAJourProgression(fraction, libelle) {
  if (libelle !== undefined) document.getElementById("statutAnalyse").textContent = libelle;
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  document.getElementById("barreProgressionRemplissage").style.width = pct + "%";
}

/* ------------------------------------------------------- calcul paresseux du spectre */
// Calcule (en tranches, cf. calculerSegmentsFftAsync dans dsp.js) le spectre
// et le spectrogramme d'une voie, et alimente cachePsd/cacheStft exactement
// comme le ferait un appel synchrone a obtenirPsd/obtenirStft (memes cles,
// meme forme de resultat) : un appel synchrone ulterieur a l'une ou l'autre
// retrouve alors le resultat deja calcule, sans le recalculer.
async function precalculerSpectral(v, onProgres) {
  const cle = v + "|" + cleFft();
  if (cachePsd.has(cle) && cacheStft.has(cle)) { if (onProgres) onProgres(1); return; }
  const r = await calculerSegmentsFftAsync(resultatsBase[v].pression, wavData.fs, fftParams, onProgres, cederAuNavigateur);
  const psdCorrige = new Float64Array(r.psd.length);
  for (let k = 0; k < r.psd.length; k++) psdCorrige[k] = r.psd[k] * Math.pow(10, -correctionMicroDb(r.freqs[k])/10);
  const bandesA = tiersOctave(r.freqs, psdCorrige, r.df, "A", resultatsBase[v].pref);
  mettreEnCache(cachePsd, cle, { freqs: r.freqs, psdBrut: r.psd, psdCorrige, df: r.df, bandesA });
  mettreEnCache(cacheStft, cle, { freqs: r.freqs, temps: r.temps, trames: r.trames, nperseg: r.nperseg, df: r.df, tramesGroupees: r.tramesGroupees });
}

/* ==================================================================== analyse */
// Au-dela de ce delai, l'analyse est anormalement longue pour l'usage prevu
// (jusqu'a 25 min, 4 voies) : on previent l'utilisatrice plutot que de la
// laisser croire que l'outil est plante, sans pour autant interrompre le
// calcul (point 3, garde-fou).
const DELAI_AVERTISSEMENT_LENTEUR_MS = 180_000; // 3 min

// Fonction asynchrone, decoupee en tranches avec des pauses reelles
// (cederAuNavigateur) a l'interieur meme du filtrage et du calcul spectral
// (pas seulement entre deux voies) : sur un fichier de plusieurs minutes,
// une seule des trois etapes de filtrage a elle seule peut prendre plusieurs
// secondes, et le decoupage laisse le navigateur repeindre la barre de
// progression regulierement pendant tout le calcul, pas seulement entre deux
// blocs de plusieurs secondes chacun.
async function demarrerAnalyse() {
  const statut = document.getElementById("statutAnalyse");
  afficherBarreProgression();
  mettreAJourProgression(0, "Preparation…");

  let alerteLenteurAffichee = false;
  const minuteur = setTimeout(() => {
    alerteLenteurAffichee = true;
    statut.textContent += " (cela prend plus longtemps que prevu — ne fermez pas cet onglet ; un fichier tres volumineux peut demander plusieurs minutes)";
  }, DELAI_AVERTISSEMENT_LENTEUR_MS);

  try {
    cachePsd.clear(); cacheStft.clear();
    resultatsBase = [];

    // Voies effectivement a calculer : celles cochees dans le panneau
    // "Voies a analyser" (page d'accueil). Une voie decochee est purement et
    // simplement ignoree ci-dessous (aucun filtrage, aucun niveau, aucune
    // entree dans resultatsBase) : ce n'est pas seulement masque a
    // l'affichage, le calcul est reellement saute.
    const indicesSelectionnes = [];
    for (let v = 0; v < wavData.nCh; v++) if (voiesSelectionnees[v]) indicesSelectionnes.push(v);
    const nSel = indicesSelectionnes.length;

    // Poids indicatifs de la barre de progression globale : le calcul des
    // niveaux (filtrage passe-haut + ponderations A/C, sur les nSel voies
    // cochees) est le poste le plus couteux mesure sur un fichier long ; le
    // spectre et le spectrogramme ne sont precalcules ici que pour la
    // premiere voie cochee affichee (les autres sont calcules a la demande,
    // cf. activerOnglet).
    const POIDS_NIVEAUX = 0.7, POIDS_SPECTRE_INITIAL = 0.3;

    for (let i = 0; i < nSel; i++) {
      const v = indicesSelectionnes[i];
      const spl = calibration[v];
      const calibre = spl !== null && spl !== undefined;
      const pref = calibre ? PREF : 1.0;
      const gain = calibre ? PREF*Math.pow(10, spl/20) : 1.0;
      const pression = wavData.canaux[v].map(x=>x*gain);

      const libelle = `Calcul des niveaux — ${nomVoie(v)} (${i+1}/${nSel})…`;
      function progresNiveaux(fraction) {
        mettreAJourProgression(((i + fraction) / nSel) * POIDS_NIVEAUX, libelle);
      }

      // Passe-haut 20 Hz applique en commun a tous les niveaux integres
      // (OASPL, LAeq, LCeq, LCpeak, LAFmax), avant les ponderations A/C.
      // Le spectre en bande fine, les tiers d'octave et le spectrogramme
      // restent calcules sur `pression` (non filtree), stockee ci-dessous.
      // Chacun des trois filtrages est calcule en tranches (lfilterAsync,
      // dsp.js) : meme resultat qu'un appel unique a lfilter, mais entrecoupe
      // de pauses reelles pour laisser respirer le navigateur.
      const pressionHp = await lfilterAsync(B_HP20, A_HP20, pression, f => progresNiveaux(f/3), cederAuNavigateur);
      const sigA = await lfilterAsync(B_A, A_A, pressionHp, f => progresNiveaux((1+f)/3), cederAuNavigateur);
      const sigC = await lfilterAsync(B_C, A_C, pressionHp, f => progresNiveaux((2+f)/3), cederAuNavigateur);

      resultatsBase[v] = {
        voie: v, calibre, pref, pression,
        leqA: leq(sigA, pref), leqC: leq(sigC, pref), leqZ: leq(pressionHp, pref),
        lafmax: lmaxFast(sigA, wavData.fs, pref), lcpeak: lpeak(sigC, pref),
        temporel: niveauTemporel(sigA, wavData.fs, pref, 1.0),
      };
    }

    const premiereVoie = indicesSelectionnes[0];
    fftParams = parametresFftParDefaut(wavData.fs, resultatsBase[premiereVoie].pression.length);
    voieCourbeCapteur = null;
    ongletActif = `voie${premiereVoie}`; dernierVoieActive = premiereVoie;
    comparaisonSelection = [];
    for (const v of indicesSelectionnes) comparaisonSelection[v] = true;

    // Spectre + spectrogramme de la premiere voie cochee affichee seulement
    // (calcul paresseux par onglet pour les autres, cf. activerOnglet) : sur
    // un fichier long, evite d'attendre toutes les voies avant de voir le
    // premier resultat. Calcule ici en tranches (calculerSegmentsFftAsync,
    // dsp.js) et range dans les memes caches que la version synchrone
    // (obtenirPsd / obtenirStft) : construireInterface ci-dessous n'a donc
    // plus qu'a lire un resultat deja pret.
    await precalculerSpectral(premiereVoie, f => mettreAJourProgression(POIDS_NIVEAUX + f*POIDS_SPECTRE_INITIAL,
      `Spectre et spectrogramme — ${nomVoie(premiereVoie)} (1/${nSel})…`));

    mettreAJourProgression(1, "Generation des graphiques…");
    await attendreProchaineImage();

    construireInterface();
    statut.textContent = "";
  } catch (err) {
    console.error(err);
    statut.textContent = "Erreur pendant l'analyse : " + (err && err.message ? err.message : String(err)) +
      ". Si le fichier est tres volumineux, fermer d'autres onglets pour liberer de la memoire peut aider ; sinon rechargez la page et reessayez.";
    throw err;
  } finally {
    clearTimeout(minuteur);
    masquerBarreProgression();
  }
}

function uniteCourante() {
  return resultatsBase.some(r=>r.calibre) ? "dB SPL" : "dBFS (non calibré)";
}

// Unite propre a une voie : uniteCourante() renvoie "dB SPL" des qu'UNE
// voie est etalonnee, ce qui affichait a tort une voie non etalonnee d'un
// fichier mixte comme si elle etait en dB SPL absolu. Utilisee dans
// l'onglet de chaque voie (cartes de niveaux, axes), a la difference de
// l'onglet Comparaison qui reste sur uniteCourante() (plusieurs voies sur
// le meme graphique).
function uniteVoie(v) {
  return resultatsBase[v].calibre ? "dB SPL" : "dBFS (non calibré)";
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
  const bandesA = tiersOctave(freqs, psdCorrige, df, "A", resultatsBase[v].pref);
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
  for (const v of voiesAnalysees()) onglets.push({ id: `voie${v}`, label: nomVoie(v) });
  onglets.push({ id: "comparaison", label: "Comparaison" });
  onglets.push({ id: "capteur", label: "Paramètres du capteur" });
  onglets.push({ id: "vol", label: "Vol" });

  for (const o of onglets) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.dataset.onglet = o.id;
    btn.addEventListener("click", ()=>activerOnglet(o.id));

    if (o.id.startsWith("voie")) {
      const v = parseInt(o.id.slice(4), 10);
      btn.appendChild(document.createTextNode(o.label + " "));
      btn.appendChild(creerBadgeCalibration(resultatsBase[v].calibre));
    } else {
      btn.textContent = o.label;
    }
    nav.appendChild(btn);

    const div = document.createElement("div");
    div.className = "onglet-contenu"; div.id = `contenu-${o.id}`;
    contenu.appendChild(div);
  }

  activerOnglet(ongletActif);
}

// Asynchrone : ouvrir l'onglet d'une voie dont le spectre/spectrogramme n'a
// encore jamais ete calcule pour les parametres FFT courants declenche son
// calcul a la demande (precalculerSpectral, en tranches), avec la barre de
// progression le temps du calcul — plutot que de geler l'interface sur un
// fichier long. Si le spectre est deja en cache (voie deja visitee, memes
// parametres FFT), le rendu reste synchrone et immediat comme avant.
async function activerOnglet(id) {
  ongletActif = id;
  if (id.startsWith("voie")) dernierVoieActive = parseInt(id.slice(4), 10);
  document.querySelectorAll("#tabsNav button").forEach(b=>b.classList.toggle("actif", b.dataset.onglet===id));
  document.querySelectorAll(".onglet-contenu").forEach(d=>d.classList.toggle("actif", d.id===`contenu-${id}`));

  const conteneur = document.getElementById(`contenu-${id}`);
  if (id.startsWith("voie")) {
    const v = parseInt(id.slice(4), 10);
    const cle = v + "|" + cleFft();
    if (!cachePsd.has(cle) || !cacheStft.has(cle)) {
      conteneur.innerHTML = `<p class="note">Calcul du spectre et du spectrogramme de ${nomVoie(v)}…</p>`;
      afficherBarreProgression();
      const libelle = `Spectre et spectrogramme — ${nomVoie(v)}…`;
      mettreAJourProgression(0, libelle);
      try {
        await precalculerSpectral(v, f => mettreAJourProgression(f, libelle));
      } catch (err) {
        console.error(err);
        conteneur.innerHTML = `<div class="avertissement">Erreur pendant le calcul du spectre de ${nomVoie(v)} : ${err && err.message ? err.message : String(err)}</div>`;
        masquerBarreProgression();
        return;
      }
      masquerBarreProgression();
      // L'utilisatrice a pu changer d'onglet pendant le calcul : ne pas
      // ecraser l'onglet desormais affiche avec un rendu obsolete.
      if (ongletActif !== id) return;
    }
    rendreOngletVoie(v, conteneur);
  }
  else if (id === "comparaison") rendreOngletComparaison(conteneur);
  else if (id === "capteur") rendreOngletCapteur(conteneur);
  else if (id === "vol") rendreOngletVol(conteneur);
}

function rafraichirOngletActif() { activerOnglet(ongletActif); }

/* -------------------------------------------------------------- impression */
// L'impression par onglets ne montre par defaut que l'onglet actuellement
// affiche. On rend ici le contenu des 4 voies, de la comparaison et de
// l'onglet capteur d'un coup (meme un onglet jamais visite), pendant que la
// classe "impression" force temporairement leur affichage a l'ecran pour
// que les canvas obtiennent une largeur/hauteur correcte ; le tout est
// synchrone (aucun requestAnimationFrame), donc rien n'est visible a
// l'ecran entre l'ajout et le retrait de la classe.
function preparerVueImpression() {
  if (!wavData) return;
  document.body.classList.add("impression");
  for (const v of voiesAnalysees()) rendreOngletVoie(v, document.getElementById(`contenu-voie${v}`));
  rendreOngletComparaison(document.getElementById("contenu-comparaison"));
  rendreOngletCapteur(document.getElementById("contenu-capteur"));
  rendreOngletVol(document.getElementById("contenu-vol"));
  viderDessinsEnAttente();
  document.body.classList.remove("impression");
}
window.addEventListener("beforeprint", preparerVueImpression);

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
  note.textContent = `Résolution fréquentielle : ${(wavData.fs/Math.min(fftParams.nperseg, pow2Below(maxLen))).toFixed(2)} Hz/raie. S'applique au spectre en bande fine, aux tiers d'octave et au spectrogramme, pour toutes les voies analysées.`;
  div.appendChild(note);

  return div;
}

/* ---------------------------------------------------------------- onglet voie */
function creerTitreImpression(texte) {
  const h = document.createElement("h2");
  h.className = "titre-impression";
  h.textContent = texte;
  return h;
}

// Niveaux globaux d'une voie, dans l'ordre d'affichage, et leur formatage :
// partages entre les cartes "synthese-niveaux" de l'onglet Voie et le
// tableau de l'onglet Comparaison, pour que les deux affichent exactement
// les memes valeurs (lues dans resultatsBase, jamais recalculees).
function niveauxGlobaux(r) {
  return [["OASPL", r.leqZ], ["LAeq", r.leqA], ["LCeq", r.leqC], ["LCpeak", r.lcpeak], ["LAFmax", r.lafmax]];
}
function formaterNiveau(val) { return isFinite(val) ? val.toFixed(1) : "—"; }

function rendreOngletVoie(v, conteneur) {
  const r = resultatsBase[v];
  const unite = uniteVoie(v);
  conteneur.innerHTML = "";
  conteneur.appendChild(creerTitreImpression(`${nomVoie(v)} — ${r.calibre ? "étalonnée, dB SPL" : "non étalonnée, dBFS"}`));
  conteneur.appendChild(creerControlesFft(r.pression.length));

  const cartes = document.createElement("div");
  cartes.className = "synthese-niveaux";
  cartes.innerHTML = niveauxGlobaux(r).map(([label,val])=>`<div class="carte"><div class="valeur">${formaterNiveau(val)}</div><div class="label">${label} (${unite})</div></div>`).join("");
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

  if (stft.tramesGroupees) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = `Fichier long : ${stft.tramesGroupees} trames FFT moyennées par colonne affichée sur le spectrogramme ci-dessus (résolution temporelle réduite à l'affichage seulement). Les niveaux globaux et le spectre en bande fine restent calculés sur la totalité du fichier.`;
    conteneur.appendChild(note);
  }
}

// Dessin des canvas differe au frame suivant (il doit deja etre dans le DOM,
// visible, pour avoir une largeur/hauteur). File d'attente partagee plutot
// qu'un requestAnimationFrame par bloc, pour pouvoir aussi la vider de
// facon synchrone (vue d'impression, cf. preparerVueImpression ci-dessous).
let dessinsEnAttente = [];
let vidageDejaPlanifie = false;

function planifierVidage() {
  if (vidageDejaPlanifie) return;
  vidageDejaPlanifie = true;
  requestAnimationFrame(() => { vidageDejaPlanifie = false; viderDessinsEnAttente(); });
}

function viderDessinsEnAttente() {
  const file = dessinsEnAttente;
  dessinsEnAttente = [];
  for (const { canvas, dessiner } of file) dessiner(canvas);
}

function creerBlocGraphique(idBase, titre, dessiner, nomFichierFn, classeSupp) {
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "chart" + (classeSupp ? " " + classeSupp : "");
  canvas.id = `c-${idBase}`;
  wrap.appendChild(canvas);
  wrap.appendChild(boutonExportCanvas(canvas, nomFichierFn));
  dessinsEnAttente.push({ canvas, dessiner });
  planifierVidage();
  return wrap;
}

/* ---------------------------------------------------------- onglet comparaison */
function rendreOngletComparaison(conteneur) {
  const voies = voiesAnalysees();
  const titreGraphique = `Comparaison des spectres en bande fine, ${voies.length} voie${voies.length>1?"s":""}`;
  conteneur.innerHTML = "";
  conteneur.appendChild(creerTitreImpression("Comparaison"));
  conteneur.appendChild(creerControlesFft(resultatsBase[voies[0]].pression.length));

  const cases = document.createElement("div");
  cases.className = "cases-voies";
  for (const v of voies) {
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

  // Voies cochees ci-dessus : elles seules apparaissent sur les deux
  // graphiques et dans le tableau des niveaux globaux.
  const cochees = voies.filter(v => comparaisonSelection[v]);

  // Melange de voies etalonnees (dB SPL) et non etalonnees (dBFS) parmi les
  // voies cochees : leurs niveaux ne sont pas comparables entre eux, alors
  // que uniteCourante() affiche "dB SPL" des qu'une seule voie l'est.
  const voiesSpl = cochees.filter(v => resultatsBase[v].calibre);
  const voiesDbfs = cochees.filter(v => !resultatsBase[v].calibre);
  const melange = voiesSpl.length > 0 && voiesDbfs.length > 0;
  if (melange) {
    const note = document.createElement("div");
    note.className = "avertissement avertissement-melange-unites";
    note.textContent = `Unités mélangées : ${voiesSpl.map(nomVoie).join(", ")} en dB SPL (étalonnée${voiesSpl.length>1?"s":""}), ` +
      `${voiesDbfs.map(nomVoie).join(", ")} en dBFS (non étalonnée${voiesDbfs.length>1?"s":""}). ` +
      `Les niveaux en dB SPL et en dBFS ne sont pas comparables entre eux, ni sur les graphiques ni dans le tableau ci-dessous. ` +
      `L'axe vertical indique dB SPL, mais les courbes des voies non étalonnées restent en dBFS.`;
    conteneur.appendChild(note);
  }

  const unite = uniteCourante();
  const series = [];
  for (const v of cochees) {
    const { freqs, psdCorrige } = obtenirPsd(v);
    series.push({ xs: Array.from(freqs), ys: psdEnDb(psdCorrige, resultatsBase[v].pref), couleur: PALETTE_VOIES[v], label: nomVoie(v) });
  }

  conteneur.appendChild(creerBlocGraphique("comparaison-spectre",
    titreGraphique,
    (canvas)=>{
      if (!series.length) { dessinerMessageAucuneVoie(canvas); return; }
      tracerCourbe(canvas, series, { titre: titreGraphique, xlabel: "fréquence (Hz)", ylabel: `niveau (${unite})`, logX: true, xMin: 20, xMax: wavData.fs/2, formatX: formatHz });
    },
    () => `${baseNomFichier()}_comparaison-spectre.png`));

  // Niveau court terme : memes donnees que la courbe "Evolution du niveau
  // dans le temps" de chaque onglet Voie (resultatsBase[v].temporel), axe
  // en secondes comme dans ces onglets, quelle que soit la duree du fichier.
  const titreNiveaux = `Comparaison des niveaux sonores, LAeq court terme (1 s), ${voies.length} voie${voies.length>1?"s":""}` +
    (melange ? " (dB SPL et dBFS mélangés, non comparables)" : "");
  const seriesNiveaux = cochees.map(v => ({
    xs: resultatsBase[v].temporel.temps, ys: resultatsBase[v].temporel.niveaux, couleur: PALETTE_VOIES[v], label: nomVoie(v),
  }));

  conteneur.appendChild(creerBlocGraphique("comparaison-niveaux",
    titreNiveaux,
    (canvas)=>{
      if (!seriesNiveaux.length) { dessinerMessageAucuneVoie(canvas); return; }
      if (!seriesNiveaux.some(s => s.xs.length)) { dessinerMessageAucuneVoie(canvas, "Fichier trop court pour un niveau sur des fenêtres de 1 s."); return; }
      tracerCourbe(canvas, seriesNiveaux, { titre: titreNiveaux, xlabel: "temps (s)", ylabel: `niveau (${unite})` });
    },
    () => `${baseNomFichier()}_comparaison-niveaux.png`));

  conteneur.appendChild(creerTableauNiveauxComparaison(cochees));
}

const MESSAGE_AUCUNE_VOIE = "Sélectionnez au moins une voie ci-dessus.";

function dessinerMessageAucuneVoie(canvas, message) {
  const {ctx,w,h} = preparerCanvas(canvas);
  ctx.clearRect(0,0,w,h); ctx.fillStyle="#5b6270"; ctx.font="13px sans-serif";
  ctx.fillText(message || MESSAGE_AUCUNE_VOIE, 20, 30);
}

// Voies signalees "niveau anormalement faible" (meme critere que la page
// d'accueil, calculerAvertissementsNiveaux), memorisees pour l'analyse en
// cours : le calcul relit le signal brut complet de chaque voie, inutile de
// le refaire a chaque coche ou decoche dans l'onglet Comparaison.
let avertissementsComparaison = { base: null, avert: [] };
function voiesFaiblesComparaison() {
  if (avertissementsComparaison.base !== resultatsBase) {
    avertissementsComparaison = { base: resultatsBase, avert: calculerAvertissementsNiveaux(niveauxRapidesParVoie()) };
  }
  return avertissementsComparaison.avert;
}

// Tableau des niveaux globaux des voies cochees : memes valeurs, meme
// formatage et meme unite par voie que les cartes de l'onglet Voie
// (niveauxGlobaux, formaterNiveau, uniteVoie). Une voie signalee faible
// reste affichee, avec le meme badge que sur la page d'accueil.
function creerTableauNiveauxComparaison(cochees) {
  const bloc = document.createElement("div");
  bloc.className = "tableau-niveaux-comparaison";
  bloc.id = "tableau-niveaux-comparaison";

  const titre = document.createElement("h3");
  titre.textContent = "Niveaux globaux sur toute la durée";
  bloc.appendChild(titre);

  if (!cochees.length) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = MESSAGE_AUCUNE_VOIE;
    bloc.appendChild(p);
    return bloc;
  }

  const avert = voiesFaiblesComparaison();
  const enTetes = niveauxGlobaux(resultatsBase[cochees[0]]).map(([label]) => `<th>${label}</th>`).join("");
  const lignes = cochees.map(v => {
    const r = resultatsBase[v];
    const badgeFaible = avert[v] ? ` <span class="badge-niveau-faible">⚠ signal anormalement faible</span>` : "";
    const cellules = niveauxGlobaux(r).map(([, val]) => `<td>${formaterNiveau(val)}</td>`).join("");
    return `<tr data-voie="${v}"><td><span class="pastille" style="background:${PALETTE_VOIES[v]}"></span>${nomVoie(v)}${badgeFaible}</td>${cellules}<td>${uniteVoie(v)}</td></tr>`;
  }).join("");
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Voie</th>${enTetes}<th>Unité</th></tr></thead><tbody>${lignes}</tbody>`;
  bloc.appendChild(table);

  const faibles = cochees.filter(v => avert[v]).map(nomVoie);
  if (faibles.length) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = `${faibles.join(", ")} ${faibles.length>1?"ont été signalées":"a été signalée"} avec un signal anormalement faible sur la page d'accueil (micro débranché ou mal connecté possible). ` +
      `${faibles.length>1?"Elles restent affichées":"Elle reste affichée"} ici : ${faibles.length>1?"décochez-les ci-dessus pour les retirer":"décochez-la ci-dessus pour la retirer"} de la comparaison.`;
    bloc.appendChild(note);
  }
  return bloc;
}

/* ------------------------------------------------------------- onglet capteur */
function rendreOngletCapteur(conteneur) {
  if (voieCourbeCapteur === null) voieCourbeCapteur = dernierVoieActive;
  conteneur.innerHTML = "";
  conteneur.appendChild(creerTitreImpression("Paramètres du capteur"));

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
  for (const v of voiesAnalysees()) {
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
    `<table><thead><tr><th>Voie</th><th>OASPL (${unite})</th><th>LAeq (${unite})</th><th>LCeq (${unite})</th><th>LCpeak (${unite})</th><th>LAFmax (${unite})</th><th>État</th></tr></thead><tbody>` +
    resultatsBase.map(r=>`<tr><td>${nomVoie(r.voie)}</td><td>${r.leqZ.toFixed(1)}</td><td>${r.leqA.toFixed(1)}</td><td>${r.leqC.toFixed(1)}</td><td>${r.lcpeak.toFixed(1)}</td><td>${r.lafmax.toFixed(1)}</td>` +
      `<td><span class="badge-cal ${r.calibre ? "calibre" : "non-calibre"}" title="${r.calibre ? "Voie étalonnée : niveaux en dB SPL absolu." : "Voie non étalonnée : niveaux en dBFS relatif, pas de dB SPL absolu fiable."}">${r.calibre ? "dB SPL" : "dBFS"}</span></td></tr>`).join("") +
    `</tbody></table>
     <dl class="lexique" style="margin-top:.8rem;">
       <dt>OASPL</dt><dd>niveau global non pondéré (linéaire), sur toute la durée.</dd>
       <dt>LAeq</dt><dd>niveau moyen en dB(A) sur toute la durée, la référence pour une exposition sonore.</dd>
       <dt>LCeq</dt><dd>niveau moyen en dB(C) sur toute la durée.</dd>
       <dt>LCpeak</dt><dd>niveau de crête en dB(C), pour un événement bref et fort.</dd>
       <dt>LAFmax</dt><dd>niveau maximal en dB(A), intégration rapide (125 ms).</dd>
     </dl>
     <p class="note" style="font-size:.82rem; color:var(--ink-soft); margin:.4rem 0 0;">
       Ces cinq niveaux globaux sont calculés après un filtre passe-haut à 20 Hz (Butterworth ordre 2) : le contenu
       en dessous de 20 Hz n'y contribue plus. Le spectre en bande fine et les tiers d'octave, dans chaque onglet
       Voie, restent inchangés et affichent tout le contenu disponible, y compris en dessous de 20 Hz.
     </p>
     <button class="secondaire no-print" id="btnCsv">Télécharger le tableau (CSV)</button>
     <button class="secondaire no-print" id="btnPdf" style="margin-left:.6rem;">Imprimer / enregistrer en PDF</button>`;

  requestAnimationFrame(()=>{
    document.getElementById("btnCsv").addEventListener("click", ()=>telechargerCsv());
    document.getElementById("btnPdf").addEventListener("click", ()=>{ preparerVueImpression(); window.print(); });
  });
  return panel;
}

function telechargerCsv() {
  const unite = uniteCourante();
  let csv = `voie,calibre,OASPL (${unite}),LAeq (${unite}),LCeq (${unite}),LAFmax (${unite}),LCpeak (${unite}),duree_s\n`;
  for (const v of voiesAnalysees()) {
    const r = resultatsBase[v];
    csv += `${nomVoie(r.voie)},${r.calibre?"oui":"non"},${r.leqZ.toFixed(2)},${r.leqA.toFixed(2)},${r.leqC.toFixed(2)},${r.lafmax.toFixed(2)},${r.lcpeak.toFixed(2)},${wavData.dureeS.toFixed(2)}\n`;
  }
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = baseNomFichier() + "_resultats.csv";
  a.click();
}
