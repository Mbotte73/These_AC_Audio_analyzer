"use strict";
/* =========================================================================
   VOL.JS — onglet "Vol" : recalage temporel et visualisation conjointe du
   WAV (Teensy, deja analyse par app.js/dsp.js), d'un export GPS phyphox et
   d'un nombre variable d'exports accelerometre phyphox (0 a VOL_MAX_ACCEL
   telephones esclaves, selon le vol), sur une carte satellite (Leaflet) et
   trois graphiques empiles a zoom lie.

   Reutilise sans les recalculer : le parseur WAV (dsp.js), le niveau LAeq
   court terme deja calcule par voie dans resultatsBase (app.js), et les
   utilitaires de dessin Canvas (charts.js). N'ajoute que ce qui est propre
   au vol : parsing phyphox (phyphox.js), horodatage, recalage, carte, KML.
   ========================================================================= */

let volGps = null;                 // { temps, lat, lon, alt, altitudeDisponible, instantAbsoluDebut, nomFichier }

// Accelerometres esclaves : nombre variable selon le vol (0 a VOL_MAX_ACCEL),
// une zone de depot par element du tableau. volAccel[i] = donnees parsees
// (ou null si la zone i est encore vide) ; volDecalages.accel[i] = decalage
// (s) de cette meme zone, independant de volAccel (un decalage peut avoir
// ete regle a la main avant meme qu'un fichier y soit depose).
const VOL_MAX_ACCEL = 4;
let volAccel = [];
let volNombreZonesAccel = 2;        // zones de depot affichees (2 par defaut, "+ Ajouter" jusqu'a VOL_MAX_ACCEL)
let volDecalages = { gps: 0, accel: [] }; // secondes ajoutees au temps natif du fichier phyphox pour rejoindre le temps WAV
let volZoomMin = null, volZoomMax = null; // minutes ; null = domaine complet
let volSurvolMinutes = null;
let volDragEtat = null;
let volCanvases = null;
let volMapInstance = null, volTrajectoireLayer = null, volCurseurMarker = null;
let volEcouteursGlobauxInstalles = false;
let volRedessinPlanifie = false;

// Horloge de lecture animee (Tache A) : etat unique, avance par
// requestAnimationFrame (temps reel ecoule x vitesse). Tous les elements
// visuels (troncature des 3 courbes, ligne verticale, marqueur carte) sont
// de simples fonctions de volLecturePosition, pas des horloges separees.
// volLecturePosition === null : mode normal (pas de lecture entamee), les 3
// courbes s'affichent completes comme aujourd'hui, aucune ligne verticale ;
// des qu'elle est non-nulle (lecture demarree ou glissiere utilisee au moins
// une fois), l'onglet passe en "mode lecture" (cf. volModeLectureActif()).
let volLecturePosition = null;   // minutes, dans le domaine du vol
let volLectureEnCours = false;
let volLectureVitesse = 60;      // x1, x10, x60, x300 (defaut x60 : vol de plusieurs dizaines de minutes)
let volLectureFrameId = null;
let volLectureDernierTs = null;
let volControlesLecture = null;  // { btnPlay, slider, labelTemps } (references DOM)

// Couleur de la trace GPS (Tache B) : bascule altitude / niveau sonore
// moyen, altitude par defaut pour ne rien changer a l'usage existant.
let volCouleurTrace = "altitude";     // "altitude" | "son"
let volInclureVoiesFaibles = false;   // reintegrer dans la moyenne les voies signalees "niveau anormalement faible"
let volControleCouleurTrace = null;   // { sel, optSon }
let volLegendeCouleurTrace = null;    // { min, titre, max }
// Cache de calculerAvertissementsNiveaux(niveauxRapidesParVoie()) (app.js) :
// ce calcul relit l'integralite du signal brut de chaque voie (leq(), cout
// O(n)) ; recalcule une seule fois par (re)rendu de l'onglet (rendreOngletVol)
// plutot qu'a chaque frame de lecture ou chaque survol souris, qui appellent
// redessinerVol() jusqu'a 60 fois par seconde (cf. volVoiesValides()).
let volAvertissementsNiveauxCache = null;

/* ------------------------------------------------------------- horodatage */
// Le fichier .TXT ecrit par le firmware Teensy contient "Date et heure :
// AAAA-MM-JJ HH:MM:SS" quand l'horloge RTC etait synchronisee (ou la
// mention explicite "NON DISPONIBLE" sinon, cf. projet_enregistreur.ino).
function extraireHorodatageTxt(texte) {
  if (!texte) return null;
  const m = /Date et heure\s*:\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(texte);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function pad2(n) { return String(n).padStart(2, "0"); }
function formatDateVolFr(d) {
  return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()} à ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ---------------------------------------------------------- degrade viridis */
const VIRIDIS_STOPS = [
  [0.000,68,1,84],[0.067,72,26,108],[0.133,71,47,125],[0.200,65,68,135],
  [0.267,57,86,140],[0.333,49,104,142],[0.400,42,120,142],[0.467,35,136,142],
  [0.533,31,152,139],[0.600,34,168,132],[0.667,53,183,121],[0.733,84,197,104],
  [0.800,122,209,81],[0.867,165,219,54],[0.933,210,226,27],[1.000,253,231,37],
];
function viridisRGB(t) {
  t = Math.min(Math.max(t, 0), 1);
  let i = 0; while (i < VIRIDIS_STOPS.length-2 && t > VIRIDIS_STOPS[i+1][0]) i++;
  const [t0,r0,g0,b0] = VIRIDIS_STOPS[i], [t1,r1,g1,b1] = VIRIDIS_STOPS[i+1];
  const f = (t-t0)/(t1-t0 || 1);
  return [Math.round(r0+f*(r1-r0)), Math.round(g0+f*(g1-g0)), Math.round(b0+f*(b1-b0))];
}
function viridisCss(t) { const [r,g,b] = viridisRGB(t); return `rgb(${r},${g},${b})`; }

/* ------------------------------------------------------------- domaine temps */
function tempsCommunSecondes(serie, decalage) { return serie.temps.map(t => t + decalage); }

function volDomaineComplet() {
  let mn = 0, mx = wavData ? wavData.dureeS : 1;
  function etendre(temps) { for (const t of temps) { if (t < mn) mn = t; if (t > mx) mx = t; } }
  if (volGps) etendre(tempsCommunSecondes(volGps, volDecalages.gps));
  for (let i = 0; i < volAccel.length; i++) {
    if (volAccel[i]) etendre(tempsCommunSecondes(volAccel[i], volDecalages.accel[i] || 0));
  }
  return { min: mn/60, max: mx/60 };
}

/* ============================================================ construction UI */
function rendreOngletVol(conteneur) {
  conteneur.innerHTML = "";
  volAvertissementsNiveauxCache = calculerAvertissementsNiveaux(niveauxRapidesParVoie());
  conteneur.appendChild(creerTitreImpression("Vol"));

  const horodatage = extraireHorodatageTxt(txtTexte);
  const titre = document.createElement("h3");
  titre.textContent = horodatage
    ? `Vol du ${formatDateVolFr(horodatage)}`
    : "Vol — horodatage du WAV indisponible (fichier .TXT absent, ou horloge RTC du Teensy non synchronisee lors de l'enregistrement)";
  conteneur.appendChild(titre);

  conteneur.appendChild(creerZoneDepotVol());

  const barreOutils = document.createElement("div");
  barreOutils.className = "vol-outils no-print";
  const btnReset = document.createElement("button");
  btnReset.type = "button"; btnReset.className = "secondaire";
  btnReset.textContent = "Réinitialiser le zoom";
  btnReset.addEventListener("click", () => { volZoomMin = null; volZoomMax = null; redessinerVol(); });
  barreOutils.appendChild(btnReset);
  const noteZoom = document.createElement("span");
  noteZoom.className = "note"; noteZoom.style.marginLeft = ".8rem";
  noteZoom.textContent = "Glissez sur un graphique pour zoomer sur une période, molette pour zoomer/dézoomer, tous les graphiques restent synchronisés.";
  barreOutils.appendChild(noteZoom);
  conteneur.appendChild(barreOutils);

  conteneur.appendChild(creerBarreLectureVol());

  const layout = document.createElement("div");
  layout.className = "vol-layout";
  conteneur.appendChild(layout);

  const colGauche = document.createElement("div");
  colGauche.className = "vol-col-gauche";
  layout.appendChild(colGauche);

  const colDroite = document.createElement("div");
  colDroite.className = "vol-col-droite";
  layout.appendChild(colDroite);

  // Premier dessin via creerBlocGraphique (app.js) : passe par la meme file
  // d'attente que les autres onglets (dessinsEnAttente), videe soit au
  // prochain requestAnimationFrame (usage normal), soit de facon synchrone
  // par viderDessinsEnAttente() pendant preparerVueImpression() (export
  // PDF) — indispensable pour que l'onglet "Vol" s'imprime correctement,
  // comme les autres onglets.
  function domaineCourant() {
    const d = volDomaineComplet();
    return { xMin: volZoomMin ?? d.min, xMax: volZoomMax ?? d.max };
  }
  colGauche.appendChild(creerBlocGraphique("vol-altitude", "Altitude du vol",
    (canvas) => { const { xMin, xMax } = domaineCourant(); dessinerAltitudeVol(canvas, xMin, xMax); },
    () => `${baseNomFichier()}_vol_altitude.png`));
  colGauche.appendChild(creerBlocGraphique("vol-son", `Niveau sonore, LAeq court terme (1 s), ${voiesAnalysees().length} voies`,
    (canvas) => { const { xMin, xMax } = domaineCourant(); dessinerSonVol(canvas, xMin, xMax); },
    () => `${baseNomFichier()}_vol_son.png`));
  colGauche.appendChild(creerBlocGraphique("vol-accel", libelleAccelVol(volAccel.filter(Boolean).length),
    (canvas) => { const { xMin, xMax } = domaineCourant(); dessinerAccelVol(canvas, xMin, xMax); },
    () => `${baseNomFichier()}_vol_acceleration.png`));

  const canvasAlt = document.getElementById("c-vol-altitude");
  const canvasSon = document.getElementById("c-vol-son");
  const canvasAccel = document.getElementById("c-vol-accel");

  colDroite.appendChild(creerControleCouleurTraceVol());

  const mapDiv = document.createElement("div");
  mapDiv.id = "vol-map"; mapDiv.className = "vol-map no-print";
  colDroite.appendChild(mapDiv);

  colDroite.appendChild(creerLegendeCouleurTraceVol());

  const btnKml = document.createElement("button");
  btnKml.type = "button"; btnKml.className = "secondaire no-print"; btnKml.style.marginTop = ".6rem";
  btnKml.textContent = "Exporter la trajectoire en KML";
  btnKml.addEventListener("click", () => exporterKmlVol());
  colDroite.appendChild(btnKml);

  volCanvases = { alt: canvasAlt, son: canvasSon, accel: canvasAccel };
  attacherInteractionZoom(canvasAlt);
  attacherInteractionZoom(canvasSon);
  attacherInteractionZoom(canvasAccel);

  // La carte (Leaflet, .no-print) n'a pas besoin d'etre prete pour
  // l'impression : elle reste initialisee au prochain frame seulement.
  requestAnimationFrame(() => {
    initialiserCarteVol(mapDiv);
    mettreAJourCarteVol();
  });
}

/* ------------------------------------------------------------ depot phyphox */
// Libelle du graphique d'acceleration, adapte au nombre d'accelerometres
// reellement CHARGES (pas au nombre de zones de depot affichees) : plus de
// "2 telephones" fige, correct que 0, 1, 2, 3 ou 4 exports soient presents.
function libelleAccelVol(nCharges) {
  if (nCharges === 0) return "Accélération linéaire (magnitude)";
  return `Accélération linéaire (magnitude), ${nCharges} téléphone${nCharges>1?"s":""}`;
}

function creerZoneDepotVol() {
  const wrap = document.createElement("div");
  wrap.className = "vol-depots no-print";

  wrap.appendChild(creerBlocDepotVol({
    titre: "Export GPS phyphox (position + altitude), téléphone maître",
    onFichier: async (f) => {
      const donnees = parserGpsPhyphox(await f.text());
      donnees.nomFichier = f.name;
      volGps = donnees;
      appliquerRecalageAutomatique(donnees.instantAbsoluDebut, (dec) => { volDecalages.gps = dec; });
    },
    decalageValeur: () => volDecalages.gps,
    decalageSet: (v) => { volDecalages.gps = v; },
  }));

  // Nombre variable de zones de depot accelerometre (2 par defaut, jusqu'a
  // VOL_MAX_ACCEL) : structure en liste plutot que deux variables/slots fixes
  // (volAccel[0]/volAccel[1] codes en dur auparavant), pour suivre le nombre
  // reel de telephones esclaves embarques, different a chaque vol.
  for (let i = 0; i < volNombreZonesAccel; i++) {
    wrap.appendChild(creerBlocDepotVol({
      titre: `Export accéléromètre phyphox (Accélération linéaire), téléphone esclave ${i+1}`,
      onFichier: async (f) => {
        const donnees = parserAccelPhyphox(await f.text());
        donnees.nomFichier = f.name;
        volAccel[i] = donnees;
        appliquerRecalageAutomatique(donnees.instantAbsoluDebut, (dec) => { volDecalages.accel[i] = dec; });
      },
      decalageValeur: () => volDecalages.accel[i] || 0,
      decalageSet: (v) => { volDecalages.accel[i] = v; },
    }));
  }

  if (volNombreZonesAccel < VOL_MAX_ACCEL) {
    const btnAjouter = document.createElement("button");
    btnAjouter.type = "button"; btnAjouter.className = "secondaire";
    btnAjouter.textContent = "+ Ajouter un accéléromètre";
    btnAjouter.addEventListener("click", () => {
      volNombreZonesAccel++;
      activerOnglet("vol"); // reconstruit l'onglet, une zone de depot supplementaire apparait
    });
    wrap.appendChild(btnAjouter);
  }

  return wrap;
}

// Recalage automatique : seulement si a la fois le WAV (via le .TXT) et le
// fichier phyphox exposent un horodatage absolu (cf. avertissement dans
// phyphox.js — rarement le cas pour un export CSV standard). Sinon le
// decalage reste a la valeur courante (0 par defaut, ou deja reglee a la
// main) : c'est le filet de securite demande. `setDecalage` generalise
// l'ancien acces par cle fixe (volDecalages.gps / volDecalages.accel0 /
// volDecalages.accel1) a n'importe quel emplacement du nouveau tableau
// volDecalages.accel.
function appliquerRecalageAutomatique(instantAbsoluFichier, setDecalage) {
  const instantAbsoluWav = extraireHorodatageTxt(txtTexte);
  if (instantAbsoluWav && instantAbsoluFichier) {
    setDecalage((instantAbsoluFichier.getTime() - instantAbsoluWav.getTime()) / 1000);
  }
}

// Bloc de depot generique (GPS ou accelerometre) : decalageValeur/decalageSet
// remplacent l'ancienne cle fixe unique, pour que GPS (volDecalages.gps) et
// chaque accelerometre (volDecalages.accel[i]) partagent le meme composant
// sans dupliquer sa logique — seul ce point est partage, le reste du
// traitement du GPS (parsing, carte, export KML) reste inchange.
function creerBlocDepotVol({ titre, onFichier, decalageValeur, decalageSet }) {
  const bloc = document.createElement("div");
  bloc.className = "vol-depot";

  const label = document.createElement("div");
  label.className = "vol-depot-titre";
  label.textContent = titre;
  bloc.appendChild(label);

  const input = document.createElement("input");
  input.type = "file"; input.accept = ".csv";
  bloc.appendChild(input);

  const nomFichierDiv = document.createElement("div");
  nomFichierDiv.className = "filename";
  bloc.appendChild(nomFichierDiv);

  const erreurDiv = document.createElement("div");
  erreurDiv.className = "avertissement"; erreurDiv.style.display = "none"; erreurDiv.style.marginTop = ".5rem";
  bloc.appendChild(erreurDiv);

  const labelDecalage = document.createElement("label");
  labelDecalage.className = "vol-decalage";
  labelDecalage.appendChild(document.createTextNode("Décalage (s) : "));
  const inputDecalage = document.createElement("input");
  inputDecalage.type = "number"; inputDecalage.step = "0.1";
  inputDecalage.value = String(decalageValeur());
  inputDecalage.addEventListener("input", () => {
    decalageSet(parseFloat(inputDecalage.value) || 0);
    redessinerVol();
  });
  labelDecalage.appendChild(inputDecalage);
  bloc.appendChild(labelDecalage);

  input.addEventListener("change", async () => {
    if (!input.files.length) return;
    erreurDiv.style.display = "none";
    try {
      await onFichier(input.files[0]);
      inputDecalage.value = String(decalageValeur());
      nomFichierDiv.textContent = "Chargé : " + input.files[0].name;
      redessinerVol();
    } catch (err) {
      erreurDiv.style.display = "";
      erreurDiv.textContent = "Erreur : " + err.message;
      nomFichierDiv.textContent = "";
    }
    input.value = "";
  });

  return bloc;
}

/* ==================================================== lecture animee (Tache A) */
// "Mode lecture" actif <=> une position de lecture a ete choisie (demarrage
// ou glissiere) ET on n'est pas en train de generer la vue d'impression —
// l'export PDF/PNG (preparerVueImpression, app.js) doit toujours produire les
// courbes completes, quel que soit l'etat de la lecture au moment du clic
// (Tache A.5). preparerVueImpression() ajoute la classe "impression" au body
// de facon synchrone pendant tout le rendu, y compris le vidage de la file de
// dessins en attente : verifier cette classe ici suffit, sans etat separe.
function volModeLectureActif() {
  return volLecturePosition !== null && !document.body.classList.contains("impression");
}

// Ne garde que les points dont le temps (meme unite que `limite`, ici des
// minutes) est <= limite. xs suppose croissant (serie temporelle) : on peut
// s'arreter des le premier point au-dela, pas besoin de tout parcourir.
function volTronquerSeries(xs, ys, limite) {
  const xsT = [], ysT = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > limite) break;
    xsT.push(xs[i]); ysT.push(ys[i]);
  }
  return { xs: xsT, ys: ysT };
}

function formatMinSecVol(minutes) {
  if (!isFinite(minutes)) return "0:00";
  const totalS = Math.max(0, Math.round(minutes*60));
  const m = Math.floor(totalS/60), s = totalS%60;
  return `${m}:${String(s).padStart(2,"0")}`;
}

// Zoom lie (point A.6) : si la lecture depasse la fenetre zoomee, fait
// glisser cette fenetre pour garder le curseur visible, a largeur constante.
// Choix simplifie (pas de suivi "en douceur" anime a part) : suffisant car
// deja appele a chaque frame de lecture, donc le glissement suit la lecture
// image par image des que le bord est atteint.
function volSuivreFenetreZoom() {
  if (volZoomMin === null || volZoomMax === null || volLecturePosition === null) return;
  const largeur = volZoomMax - volZoomMin;
  if (volLecturePosition > volZoomMax) {
    volZoomMax = volLecturePosition;
    volZoomMin = volZoomMax - largeur;
  } else if (volLecturePosition < volZoomMin) {
    volZoomMin = volLecturePosition;
    volZoomMax = volZoomMin + largeur;
  }
}

function volLectureTick(ts) {
  if (!volLectureEnCours) { volLectureFrameId = null; return; }
  if (volLectureDernierTs === null) volLectureDernierTs = ts;
  const dtS = Math.max(0, (ts - volLectureDernierTs) / 1000);
  volLectureDernierTs = ts;
  const domaine = volDomaineComplet();
  volLecturePosition = Math.min(domaine.max, (volLecturePosition ?? domaine.min) + (dtS*volLectureVitesse)/60);
  volSurvolMinutes = volLecturePosition; // pilote le marqueur carte existant (mettreAJourCarteVol)
  volSuivreFenetreZoom();
  if (volLecturePosition >= domaine.max - 1e-9) volLectureEnCours = false; // fin de vol : pause automatique
  redessinerVol();
  volLectureFrameId = volLectureEnCours ? requestAnimationFrame(volLectureTick) : null;
}

function demarrerLectureVol() {
  const domaine = volDomaineComplet();
  if (volLecturePosition === null || volLecturePosition >= domaine.max - 1e-9) volLecturePosition = domaine.min;
  volLectureEnCours = true;
  volLectureDernierTs = null;
  if (volLectureFrameId === null) volLectureFrameId = requestAnimationFrame(volLectureTick);
}

function arreterLectureVol() {
  volLectureEnCours = false;
  if (volLectureFrameId !== null) { cancelAnimationFrame(volLectureFrameId); volLectureFrameId = null; }
}

function creerBarreLectureVol() {
  const bar = document.createElement("div");
  bar.className = "vol-lecture no-print";

  const btnPlay = document.createElement("button");
  btnPlay.type = "button"; btnPlay.className = "secondaire";
  btnPlay.addEventListener("click", () => {
    if (volLectureEnCours) arreterLectureVol(); else demarrerLectureVol();
    redessinerVol();
  });
  bar.appendChild(btnPlay);

  const labelVitesse = document.createElement("label");
  labelVitesse.className = "vol-lecture-vitesse";
  labelVitesse.appendChild(document.createTextNode("Vitesse "));
  const selVitesse = document.createElement("select");
  for (const v of [1, 10, 60, 300]) {
    const opt = document.createElement("option");
    opt.value = String(v); opt.textContent = "x" + v;
    if (v === volLectureVitesse) opt.selected = true;
    selVitesse.appendChild(opt);
  }
  selVitesse.addEventListener("change", () => { volLectureVitesse = parseInt(selVitesse.value, 10); });
  labelVitesse.appendChild(selVitesse);
  bar.appendChild(labelVitesse);

  const slider = document.createElement("input");
  slider.type = "range"; slider.className = "vol-lecture-slider";
  slider.min = "0"; slider.max = "1"; slider.step = "0.001"; slider.value = "0";
  slider.addEventListener("input", () => {
    arreterLectureVol();
    volLecturePosition = parseFloat(slider.value);
    volSurvolMinutes = volLecturePosition;
    volSuivreFenetreZoom();
    redessinerVol();
  });
  bar.appendChild(slider);

  const labelTemps = document.createElement("span");
  labelTemps.className = "vol-lecture-temps note";
  bar.appendChild(labelTemps);

  volControlesLecture = { btnPlay, slider, labelTemps };
  mettreAJourControlesLectureVol();
  return bar;
}

function mettreAJourControlesLectureVol() {
  if (!volControlesLecture) return;
  const { btnPlay, slider, labelTemps } = volControlesLecture;
  const domaine = volDomaineComplet();
  slider.min = String(domaine.min);
  slider.max = String(domaine.max);
  slider.step = String((domaine.max - domaine.min) / 1000 || 0.001);
  // Ne pas ecraser la valeur pendant que l'utilisatrice la manipule au
  // clavier/souris (le champ a le focus) : redessinerVol() est aussi appele
  // depuis le gestionnaire "input" du meme slider.
  if (document.activeElement !== slider) slider.value = String(volLecturePosition ?? domaine.min);
  btnPlay.textContent = volLectureEnCours ? "⏸ Pause" : "▶ Lecture";
  const pos = volLecturePosition ?? domaine.min;
  labelTemps.textContent = `${formatMinSecVol(pos)} / ${formatMinSecVol(domaine.max)}`;
}

/* ============================================================== redessin */
function planifierRedessinVol() {
  if (volRedessinPlanifie) return;
  volRedessinPlanifie = true;
  requestAnimationFrame(() => { volRedessinPlanifie = false; redessinerVol(); });
}

function redessinerVol() {
  if (!wavData || !volCanvases) return;
  mettreAJourControlesLectureVol();
  mettreAJourControleCouleurTraceVol();
  const domaine = volDomaineComplet();
  const xMin = volZoomMin ?? domaine.min;
  const xMax = volZoomMax ?? domaine.max;

  dessinerAltitudeVol(volCanvases.alt, xMin, xMax);
  dessinerSonVol(volCanvases.son, xMin, xMax);
  dessinerAccelVol(volCanvases.accel, xMin, xMax);
  mettreAJourCarteVol();
  mettreAJourLegendeCouleurTraceVol();
}

function dessinerSonVol(canvas, xMin, xMax) {
  const voies = voiesAnalysees();
  const tronquer = volModeLectureActif() ? volLecturePosition : null;
  const series = [];
  for (const v of voies) {
    const r = resultatsBase[v];
    let xs = r.temporel.temps.map(t => t/60), ys = r.temporel.niveaux;
    if (tronquer !== null) ({ xs, ys } = volTronquerSeries(xs, ys, tronquer));
    series.push({ xs, ys, couleur: PALETTE_VOIES[v], label: nomVoie(v) });
  }
  tracerCourbe(canvas, series, {
    titre: `Niveau sonore, LAeq court terme (1 s), ${voies.length} voie${voies.length>1?"s":""}`,
    xlabel: "temps (min)", ylabel: `niveau (${uniteCourante()})`,
    xMin, xMax, ligneVerticaleX: tronquer,
  });
}

function dessinerAccelVol(canvas, xMin, xMax) {
  const tronquer = volModeLectureActif() ? volLecturePosition : null;
  const series = [];
  for (let i = 0; i < volAccel.length; i++) {
    if (!volAccel[i]) continue;
    const decalage = volDecalages.accel[i] || 0;
    let xs = volAccel[i].temps.map(t => (t+decalage)/60), ys = volAccel[i].magnitude;
    if (tronquer !== null) ({ xs, ys } = volTronquerSeries(xs, ys, tronquer));
    series.push({
      xs, ys,
      couleur: PALETTE_VOIES[i % PALETTE_VOIES.length], label: `Téléphone esclave ${i+1}`,
    });
  }
  const titre = libelleAccelVol(series.length);
  if (!series.length) {
    const { ctx, w, h } = preparerCanvas(canvas);
    ctx.clearRect(0,0,w,h);
    ctx.font = "13px sans-serif"; ctx.fillStyle = "#20242b";
    ctx.fillText(titre, 52, 16);
    ctx.fillStyle = "#5b6270";
    ctx.fillText("Aucun accéléromètre importé. Déposez un export accéléromètre phyphox ci-dessus pour afficher cette courbe.", 52, h/2);
    return;
  }
  tracerCourbe(canvas, series, {
    titre,
    xlabel: "temps (min)", ylabel: "accélération (m/s²)",
    xMin, xMax, ligneVerticaleX: tronquer,
  });
}

// Graphique specifique (pas une reutilisation de tracerCourbe) : bandes de
// fond colorees par tranche d'altitude (degrade viridis), en plus de la
// courbe elle-meme. Meme disposition/marges que tracerCourbe pour rester
// visuellement coherent avec le reste de l'outil.
function dessinerAltitudeVol(canvas, xMin, xMax) {
  const { ctx, w, h } = preparerCanvas(canvas);
  const M = { l: 52, r: 16, t: 26, b: 40 };
  ctx.clearRect(0,0,w,h);
  ctx.font = "13px sans-serif"; ctx.fillStyle = "#20242b";
  ctx.fillText("Altitude du vol", M.l, 16);

  if (!volGps || !volGps.altitudeDisponible) {
    ctx.fillStyle = "#5b6270";
    ctx.fillText("Déposez un export GPS phyphox ci-dessus (avec altitude) pour afficher cette courbe.", M.l, h/2);
    return;
  }

  const xs = volGps.temps.map(t => (t+volDecalages.gps)/60);
  const ys = volGps.alt;
  const tronquer = volModeLectureActif() ? volLecturePosition : null;

  let aMin = Infinity, aMax = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < xMin || xs[i] > xMax) continue;
    if (ys[i] === null || !isFinite(ys[i])) continue;
    if (ys[i] < aMin) aMin = ys[i];
    if (ys[i] > aMax) aMax = ys[i];
  }
  if (!isFinite(aMin) || !isFinite(aMax)) { aMin = 0; aMax = 1; }
  if (aMax - aMin < 1) { aMax += 0.5; aMin -= 0.5; }

  function px(x) { return M.l + (x-xMin)/((xMax-xMin) || 1)*(w-M.l-M.r); }
  function py(y) { return h-M.b - (y-aMin)/(aMax-aMin)*(h-M.t-M.b); }

  const N_BANDES = 24;
  for (let k = 0; k < N_BANDES; k++) {
    const yBas = aMin + k*(aMax-aMin)/N_BANDES;
    const yHaut = aMin + (k+1)*(aMax-aMin)/N_BANDES;
    ctx.fillStyle = viridisCss((k+0.5)/N_BANDES);
    const yPixHaut = py(yHaut), yPixBas = py(yBas);
    ctx.fillRect(M.l, yPixHaut, w-M.l-M.r, Math.max(1, yPixBas-yPixHaut));
  }

  const ticksY = ticksLineaires(aMin, aMax, 6);
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const val of ticksY) {
    const y = py(val);
    ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.beginPath(); ctx.moveTo(M.l,y); ctx.lineTo(w-M.r,y); ctx.stroke();
    ctx.fillStyle = "#20242b"; ctx.fillText(val.toFixed(0), M.l-6, y);
  }
  const ticksX = ticksLineaires(xMin, xMax, 8);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const val of ticksX) {
    const x = px(val);
    if (x < M.l-1 || x > w-M.r+1) continue;
    ctx.strokeStyle = "#c8c4ba"; ctx.beginPath(); ctx.moveTo(x,h-M.b); ctx.lineTo(x,h-M.b+4); ctx.stroke();
    ctx.fillStyle = "#5b6270"; ctx.fillText(val.toFixed(1), x, h-M.b+6);
  }
  ctx.strokeStyle = "#20242b"; ctx.beginPath(); ctx.moveTo(M.l,M.t); ctx.lineTo(M.l,h-M.b); ctx.lineTo(w-M.r,h-M.b); ctx.stroke();

  ctx.save(); ctx.beginPath(); ctx.rect(M.l,M.t,w-M.l-M.r,h-M.t-M.b); ctx.clip();
  ctx.strokeStyle = "#20242b"; ctx.lineWidth = 1.8; ctx.beginPath();
  let started = false;
  for (let i = 0; i < xs.length; i++) {
    if (tronquer !== null && xs[i] > tronquer) break; // xs croissant : rien au-dela a tracer
    if (xs[i] < xMin || xs[i] > xMax || ys[i] === null || !isFinite(ys[i])) { started = false; continue; }
    const x = px(xs[i]), y = py(ys[i]);
    if (!started) { ctx.moveTo(x,y); started = true; } else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // ligne verticale au temps courant de lecture (Tache A.3), meme clip.
  if (tronquer !== null && tronquer >= xMin && tronquer <= xMax) {
    const xv = px(tronquer);
    ctx.strokeStyle = "#c94b6a"; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]);
    ctx.beginPath(); ctx.moveTo(xv, M.t); ctx.lineTo(xv, h-M.b); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.font = "12px sans-serif"; ctx.fillStyle = "#5b6270";
  ctx.fillText("temps (min)", w-M.r-90, h-4);
  ctx.save(); ctx.translate(12, M.t+10); ctx.rotate(-Math.PI/2);
  ctx.fillText("altitude (m)", 0, 0);
  ctx.restore();
}

/* ------------------------------------------------------- interaction zoom */
function xPixelVersMinuteVol(canvas, xPx) {
  const M_L = 52, M_R = 16;
  const w = canvas.clientWidth;
  const domaine = volDomaineComplet();
  const xMin = volZoomMin ?? domaine.min, xMax = volZoomMax ?? domaine.max;
  const frac = (xPx - M_L) / Math.max(1, w-M_L-M_R);
  return xMin + frac*(xMax-xMin);
}

function volPointDansCanvas(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
}

// Ecouteurs installes une seule fois (pas a chaque rendu d'onglet, sinon
// accumulation de gestionnaires sur window a chaque revisite de l'onglet
// "Vol") ; ils regardent volCanvases (mis a jour a chaque rendu) pour
// savoir sur quel canvas courant agir.
function assurerEcouteursGlobauxVol() {
  if (volEcouteursGlobauxInstalles) return;
  volEcouteursGlobauxInstalles = true;

  window.addEventListener("mousemove", (e) => {
    if (volDragEtat || !volCanvases) return;
    for (const cle of ["alt", "son", "accel"]) {
      const canvas = volCanvases[cle];
      if (canvas && volPointDansCanvas(canvas, e)) {
        const rect = canvas.getBoundingClientRect();
        volSurvolMinutes = xPixelVersMinuteVol(canvas, e.clientX - rect.left);
        planifierRedessinVol();
        return;
      }
    }
  });

  window.addEventListener("mouseleave", () => { volSurvolMinutes = null; planifierRedessinVol(); });

  window.addEventListener("mouseup", (e) => {
    if (!volDragEtat) return;
    const canvas = volDragEtat.canvas;
    const rect = canvas.getBoundingClientRect();
    const xFinPx = e.clientX - rect.left;
    if (Math.abs(xFinPx - volDragEtat.xDebutPx) > 6) {
      const a = xPixelVersMinuteVol(canvas, volDragEtat.xDebutPx);
      const b = xPixelVersMinuteVol(canvas, xFinPx);
      volZoomMin = Math.min(a,b); volZoomMax = Math.max(a,b);
    }
    volDragEtat = null;
    redessinerVol();
  });
}

function attacherInteractionZoom(canvas) {
  assurerEcouteursGlobauxVol();

  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    volDragEtat = { xDebutPx: e.clientX - rect.left, canvas };
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const domaine = volDomaineComplet();
    const xMin = volZoomMin ?? domaine.min, xMax = volZoomMax ?? domaine.max;
    const rect = canvas.getBoundingClientRect();
    const centre = xPixelVersMinuteVol(canvas, e.clientX - rect.left);
    const facteur = e.deltaY > 0 ? 1/0.85 : 0.85;
    const largeurMax = domaine.max - domaine.min;
    let largeur = Math.min(Math.max((xMax-xMin)*facteur, largeurMax/200), largeurMax);
    let nMin = centre - (centre-xMin)/((xMax-xMin) || 1)*largeur;
    let nMax = nMin + largeur;
    if (nMin < domaine.min) { nMax += domaine.min-nMin; nMin = domaine.min; }
    if (nMax > domaine.max) { nMin -= nMax-domaine.max; nMax = domaine.max; }
    volZoomMin = nMin; volZoomMax = nMax;
    planifierRedessinVol();
  }, { passive: false });
}

/* ============================================== couleur de la trace (Tache B) */
// Voies retenues pour le calcul du niveau sonore moyen de la trace GPS :
// reutilise voiesAnalysees() (js/app.js, session precedente — une voie
// decochee n'a de toute facon aucune entree dans resultatsBase, donc ne peut
// pas etre incluse par erreur), en excluant par defaut celles signalees
// "niveau anormalement faible" par calculerAvertissementsNiveaux() (meme
// fichier, meme session) : un micro probablement debranche ne doit pas tirer
// la moyenne vers le bas. volInclureVoiesFaibles permet de les reintegrer
// explicitement (case a cocher, cf. creerControleCouleurTraceVol).
function volVoiesValides() {
  const avert = volAvertissementsNiveauxCache || [];
  return voiesAnalysees().filter(v => volInclureVoiesFaibles || !avert[v]);
}

// Interpolation lineaire simple entre les deux points de la courbe de niveau
// les plus proches de `t` (secondes, meme referentiel que `temps`) ; hors de
// la plage couverte par `temps`, renvoie la valeur la plus proche disponible
// (pas d'extrapolation), comme demande (Tache B.2).
function niveauInterpoleVol(temps, niveaux, t) {
  const n = temps.length;
  if (!n) return null;
  if (t <= temps[0]) return niveaux[0];
  if (t >= temps[n-1]) return niveaux[n-1];
  let i = 0;
  while (i < n-1 && temps[i+1] < t) i++;
  const t0 = temps[i], t1 = temps[i+1], y0 = niveaux[i], y1 = niveaux[i+1];
  const f = (t-t0) / ((t1-t0) || 1);
  return y0 + f*(y1-y0);
}

// Niveau sonore moyen (voies valides uniquement) a l'instant de chaque point
// GPS, apres recalage temporel (volDecalages.gps) : null si aucune voie
// valide ou pas de trace GPS chargee.
function calculerNiveauxMoyensGps() {
  if (!volGps || !volGps.lat.length) return null;
  const voies = volVoiesValides();
  if (!voies.length) return null;
  const n = volGps.lat.length;
  const niveaux = new Array(n);
  for (let i = 0; i < n; i++) {
    const tWav = volGps.temps[i] + volDecalages.gps;
    let somme = 0;
    for (const v of voies) somme += niveauInterpoleVol(resultatsBase[v].temporel.temps, resultatsBase[v].temporel.niveaux, tWav);
    niveaux[i] = somme / voies.length;
  }
  return niveaux;
}

// Valeurs (altitude ou niveau sonore moyen) et normalisation associees, selon
// le mode courant (volCouleurTrace) : partagees par la carte, la legende et
// l'export KML (Tache B.5), pour qu'ils restent toujours coherents entre eux.
function volValeursCouleurTrace() {
  if (!volGps || !volGps.lat.length) return null;
  let valeurs;
  if (volCouleurTrace === "son") {
    valeurs = calculerNiveauxMoyensGps();
    if (!valeurs) return null;
  } else {
    valeurs = volGps.alt;
  }
  let vMin = Infinity, vMax = -Infinity;
  for (const v of valeurs) if (v !== null && isFinite(v)) { if (v<vMin) vMin=v; if (v>vMax) vMax=v; }
  const ok = isFinite(vMin) && isFinite(vMax) && vMax > vMin;
  return { valeurs, vMin, vMax, ok };
}

function creerControleCouleurTraceVol() {
  const wrap = document.createElement("div");
  wrap.className = "vol-couleur-trace no-print";

  const label = document.createElement("label");
  label.appendChild(document.createTextNode("Couleur de la trace : "));
  const sel = document.createElement("select");
  const optAlt = document.createElement("option"); optAlt.value = "altitude"; optAlt.textContent = "Altitude";
  const optSon = document.createElement("option"); optSon.value = "son"; optSon.textContent = "Niveau sonore";
  sel.appendChild(optAlt); sel.appendChild(optSon);
  sel.value = volCouleurTrace;
  sel.addEventListener("change", () => { volCouleurTrace = sel.value; redessinerVol(); });
  label.appendChild(sel);
  wrap.appendChild(label);

  const labelInclure = document.createElement("label");
  labelInclure.className = "vol-inclure-faibles";
  const cbInclure = document.createElement("input");
  cbInclure.type = "checkbox"; cbInclure.checked = volInclureVoiesFaibles;
  cbInclure.addEventListener("change", () => { volInclureVoiesFaibles = cbInclure.checked; redessinerVol(); });
  labelInclure.appendChild(cbInclure);
  labelInclure.appendChild(document.createTextNode(" inclure les voies signalées faibles"));
  labelInclure.title = "Une voie cochée mais signalée \"niveau anormalement faible\" (page d'accueil) est exclue par défaut de la moyenne du niveau sonore : un micro probablement débranché ne doit pas tirer la moyenne vers le bas.";
  wrap.appendChild(labelInclure);

  volControleCouleurTrace = { sel, optSon };
  mettreAJourControleCouleurTraceVol();
  return wrap;
}

// Desactive l'option "Niveau sonore" (avec explication) quand aucune voie
// valide n'est retenue (Tache B.4), et rebascule sur "Altitude" si le mode
// "son" etait actif et devient indisponible.
function mettreAJourControleCouleurTraceVol() {
  if (!volControleCouleurTrace) return;
  const { sel, optSon } = volControleCouleurTrace;
  const dispo = volVoiesValides().length > 0;
  optSon.disabled = !dispo;
  optSon.title = dispo ? "" : "Aucune voie valide retenue pour calculer un niveau sonore moyen (toutes décochées, ou toutes signalées comme anormalement faibles).";
  if (!dispo && volCouleurTrace === "son") { volCouleurTrace = "altitude"; sel.value = "altitude"; }
}

function creerLegendeCouleurTraceVol() {
  const wrap = document.createElement("div");
  wrap.className = "vol-legende no-print";
  const barre = document.createElement("div");
  barre.className = "vol-legende-barre";
  const grad = VIRIDIS_STOPS.map(s => `${viridisCss(s[0])} ${(s[0]*100).toFixed(1)}%`).join(", ");
  barre.style.background = `linear-gradient(to right, ${grad})`;
  wrap.appendChild(barre);
  const labels = document.createElement("div");
  labels.className = "vol-legende-labels";
  const min = document.createElement("span"), titre = document.createElement("span"), max = document.createElement("span");
  labels.appendChild(min); labels.appendChild(titre); labels.appendChild(max);
  wrap.appendChild(labels);
  volLegendeCouleurTrace = { min, titre, max };
  mettreAJourLegendeCouleurTraceVol();
  return wrap;
}

function mettreAJourLegendeCouleurTraceVol() {
  if (!volLegendeCouleurTrace) return;
  const { min, titre, max } = volLegendeCouleurTrace;
  titre.textContent = volCouleurTrace === "son" ? `Niveau sonore moyen (${uniteCourante()})` : "Altitude (m)";
  const couleurs = volValeursCouleurTrace();
  const chiffres = volCouleurTrace === "son" ? 1 : 0;
  if (couleurs && couleurs.ok) {
    min.textContent = couleurs.vMin.toFixed(chiffres);
    max.textContent = couleurs.vMax.toFixed(chiffres);
  } else {
    min.textContent = "—"; max.textContent = "—";
  }
}

/* ===================================================================== carte */
function initialiserCarteVol(mapDiv) {
  if (volMapInstance) { volMapInstance.remove(); volMapInstance = null; }
  if (typeof L === "undefined") return; // Leaflet non charge (pas d'acces reseau) : carte simplement absente

  volMapInstance = L.map(mapDiv, { zoomControl: true }).setView([0,0], 2);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri — Source : Esri, Maxar, Earthstar Geographics, GIS User Community",
  }).addTo(volMapInstance);
  volTrajectoireLayer = L.layerGroup().addTo(volMapInstance);
  volCurseurMarker = null;
  requestAnimationFrame(() => { if (volMapInstance) volMapInstance.invalidateSize(); });
}

function mettreAJourCarteVol() {
  if (!volMapInstance) return;
  volTrajectoireLayer.clearLayers();
  if (!volGps || !volGps.lat.length) return;

  const pts = volGps.lat.map((lat,i) => ({ lat, lon: volGps.lon[i], t: (volGps.temps[i]+volDecalages.gps)/60 }));
  const couleurs = volValeursCouleurTrace();

  for (let i = 0; i < pts.length-1; i++) {
    const t = couleurs && couleurs.ok ? (((couleurs.valeurs[i]+couleurs.valeurs[i+1])/2)-couleurs.vMin)/(couleurs.vMax-couleurs.vMin) : 0.5;
    L.polyline([[pts[i].lat,pts[i].lon],[pts[i+1].lat,pts[i+1].lon]], { color: viridisCss(t), weight: 4, opacity: .9 }).addTo(volTrajectoireLayer);
  }

  const dep = pts[0], arr = pts[pts.length-1];
  L.circleMarker([dep.lat,dep.lon], { radius:7, color:"#1d6b3a", fillColor:"#2e8b57", fillOpacity:1, weight:2 }).bindTooltip("Départ").addTo(volTrajectoireLayer);
  L.circleMarker([arr.lat,arr.lon], { radius:7, color:"#8a2040", fillColor:"#c94b6a", fillOpacity:1, weight:2 }).bindTooltip("Arrivée").addTo(volTrajectoireLayer);

  if (!volMapInstance._volBoundsFites) {
    volMapInstance.fitBounds(L.latLngBounds(pts.map(p => [p.lat,p.lon])), { padding: [20,20] });
    volMapInstance._volBoundsFites = true;
  }

  if (volSurvolMinutes !== null) {
    let idx = 0, ecartMin = Infinity;
    for (let i = 0; i < pts.length; i++) { const e = Math.abs(pts[i].t-volSurvolMinutes); if (e<ecartMin) { ecartMin=e; idx=i; } }
    const p = pts[idx];
    if (!volCurseurMarker) volCurseurMarker = L.circleMarker([p.lat,p.lon], { radius:6, color:"#20242b", fillColor:"#ffd54a", fillOpacity:1, weight:2 }).addTo(volMapInstance);
    else { volCurseurMarker.setLatLng([p.lat,p.lon]); if (!volMapInstance.hasLayer(volCurseurMarker)) volCurseurMarker.addTo(volMapInstance); }
  } else if (volCurseurMarker) {
    volMapInstance.removeLayer(volCurseurMarker);
  }
}

/* ==================================================================== KML */
function couleurKmlDepuisRgb(r, g, b, alpha) {
  alpha = alpha === undefined ? 255 : alpha;
  const h = n => n.toString(16).padStart(2, "0");
  return h(alpha) + h(b) + h(g) + h(r); // KML : aabbggrr
}

function exporterKmlVol() {
  if (!volGps || !volGps.lat.length) { alert("Aucune trajectoire GPS chargée à exporter."); return; }
  const pts = volGps.lat.map((lat,i) => ({ lat, lon: volGps.lon[i], alt: volGps.alt[i] }));

  // altitudeMode du KML (rendu 3D dans Google Earth) : independant du mode de
  // coloration choisi ci-dessous, se base uniquement sur la disponibilite
  // reelle de l'altitude GPS.
  let aMin = Infinity, aMax = -Infinity;
  for (const p of pts) if (p.alt !== null && isFinite(p.alt)) { if (p.alt<aMin) aMin=p.alt; if (p.alt>aMax) aMax=p.alt; }
  const altitudeModeOk = isFinite(aMin) && isFinite(aMax) && aMax > aMin;

  // Couleur de la trace exportee : suit le mode actuellement affiche a
  // l'ecran (altitude ou niveau sonore), pas toujours l'altitude (Tache B.5).
  const couleurs = volValeursCouleurTrace();

  let placemarks = "";
  for (let i = 0; i < pts.length-1; i++) {
    const t = couleurs && couleurs.ok ? (((couleurs.valeurs[i]+couleurs.valeurs[i+1])/2)-couleurs.vMin)/(couleurs.vMax-couleurs.vMin) : 0.5;
    const [r,g,b] = viridisRGB(t);
    const alt1 = altitudeModeOk ? pts[i].alt : 0, alt2 = altitudeModeOk ? pts[i+1].alt : 0;
    placemarks += `
    <Placemark>
      <Style><LineStyle><color>${couleurKmlDepuisRgb(r,g,b)}</color><width>4</width></LineStyle></Style>
      <LineString>
        <altitudeMode>${altitudeModeOk ? "absolute" : "clampToGround"}</altitudeMode>
        <coordinates>${pts[i].lon},${pts[i].lat},${alt1} ${pts[i+1].lon},${pts[i+1].lat},${alt2}</coordinates>
      </LineString>
    </Placemark>`;
  }

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Trajectoire du vol</name>
    ${placemarks}
  </Document>
</kml>`;

  const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (wavData ? baseNomFichier() : "vol") + "_trajectoire.kml";
  a.click();
}
