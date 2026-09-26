"use strict";
/* =========================================================================
   VOL.JS — onglet "Vol" : recalage temporel et visualisation conjointe du
   WAV 4 voies (Teensy, deja analyse par app.js/dsp.js), d'un export GPS
   phyphox et de deux exports accelerometre phyphox, sur une carte
   satellite (Leaflet) et trois graphiques empiles a zoom lie.

   Reutilise sans les recalculer : le parseur WAV (dsp.js), le niveau LAeq
   court terme deja calcule par voie dans resultatsBase (app.js), et les
   utilitaires de dessin Canvas (charts.js). N'ajoute que ce qui est propre
   au vol : parsing phyphox (phyphox.js), horodatage, recalage, carte, KML.
   ========================================================================= */

let volGps = null;                 // { temps, lat, lon, alt, altitudeDisponible, instantAbsoluDebut, nomFichier }
let volAccel = [null, null];       // par telephone esclave
let volDecalages = { gps: 0, accel0: 0, accel1: 0 }; // secondes ajoutees au temps natif du fichier phyphox pour rejoindre le temps WAV
let volZoomMin = null, volZoomMax = null; // minutes ; null = domaine complet
let volSurvolMinutes = null;
let volDragEtat = null;
let volCanvases = null;
let volMapInstance = null, volTrajectoireLayer = null, volCurseurMarker = null;
let volEcouteursGlobauxInstalles = false;
let volRedessinPlanifie = false;

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
  if (volAccel[0]) etendre(tempsCommunSecondes(volAccel[0], volDecalages.accel0));
  if (volAccel[1]) etendre(tempsCommunSecondes(volAccel[1], volDecalages.accel1));
  return { min: mn/60, max: mx/60 };
}

/* ============================================================ construction UI */
function rendreOngletVol(conteneur) {
  conteneur.innerHTML = "";
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
  colGauche.appendChild(creerBlocGraphique("vol-son", "Niveau sonore, LAeq court terme (1 s), 4 voies",
    (canvas) => { const { xMin, xMax } = domaineCourant(); dessinerSonVol(canvas, xMin, xMax); },
    () => `${baseNomFichier()}_vol_son.png`));
  colGauche.appendChild(creerBlocGraphique("vol-accel", "Accélération linéaire (magnitude), 2 téléphones",
    (canvas) => { const { xMin, xMax } = domaineCourant(); dessinerAccelVol(canvas, xMin, xMax); },
    () => `${baseNomFichier()}_vol_acceleration.png`));

  const canvasAlt = document.getElementById("c-vol-altitude");
  const canvasSon = document.getElementById("c-vol-son");
  const canvasAccel = document.getElementById("c-vol-accel");

  const mapDiv = document.createElement("div");
  mapDiv.id = "vol-map"; mapDiv.className = "vol-map no-print";
  colDroite.appendChild(mapDiv);

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
function creerZoneDepotVol() {
  const wrap = document.createElement("div");
  wrap.className = "vol-depots no-print";

  wrap.appendChild(creerBlocDepotVol({
    titre: "Export GPS phyphox (position + altitude), téléphone maître",
    onFichier: async (f) => {
      const donnees = parserGpsPhyphox(await f.text());
      donnees.nomFichier = f.name;
      volGps = donnees;
      appliquerRecalageAutomatique("gps", donnees.instantAbsoluDebut);
    },
    decalageCle: "gps",
  }));

  wrap.appendChild(creerBlocDepotVol({
    titre: "Export accéléromètre phyphox (Accélération linéaire), téléphone esclave 1",
    onFichier: async (f) => {
      const donnees = parserAccelPhyphox(await f.text());
      donnees.nomFichier = f.name;
      volAccel[0] = donnees;
      appliquerRecalageAutomatique("accel0", donnees.instantAbsoluDebut);
    },
    decalageCle: "accel0",
  }));

  wrap.appendChild(creerBlocDepotVol({
    titre: "Export accéléromètre phyphox (Accélération linéaire), téléphone esclave 2",
    onFichier: async (f) => {
      const donnees = parserAccelPhyphox(await f.text());
      donnees.nomFichier = f.name;
      volAccel[1] = donnees;
      appliquerRecalageAutomatique("accel1", donnees.instantAbsoluDebut);
    },
    decalageCle: "accel1",
  }));

  return wrap;
}

// Recalage automatique : seulement si a la fois le WAV (via le .TXT) et le
// fichier phyphox exposent un horodatage absolu (cf. avertissement dans
// phyphox.js — rarement le cas pour un export CSV standard). Sinon le
// decalage reste a la valeur courante (0 par defaut, ou deja reglee a la
// main) : c'est le filet de securite demande.
function appliquerRecalageAutomatique(cle, instantAbsoluFichier) {
  const instantAbsoluWav = extraireHorodatageTxt(txtTexte);
  if (instantAbsoluWav && instantAbsoluFichier) {
    volDecalages[cle] = (instantAbsoluFichier.getTime() - instantAbsoluWav.getTime()) / 1000;
  }
}

function creerBlocDepotVol({ titre, onFichier, decalageCle }) {
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
  inputDecalage.value = String(volDecalages[decalageCle]);
  inputDecalage.addEventListener("input", () => {
    volDecalages[decalageCle] = parseFloat(inputDecalage.value) || 0;
    redessinerVol();
  });
  labelDecalage.appendChild(inputDecalage);
  bloc.appendChild(labelDecalage);

  input.addEventListener("change", async () => {
    if (!input.files.length) return;
    erreurDiv.style.display = "none";
    try {
      await onFichier(input.files[0]);
      inputDecalage.value = String(volDecalages[decalageCle]);
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

/* ============================================================== redessin */
function planifierRedessinVol() {
  if (volRedessinPlanifie) return;
  volRedessinPlanifie = true;
  requestAnimationFrame(() => { volRedessinPlanifie = false; redessinerVol(); });
}

function redessinerVol() {
  if (!wavData || !volCanvases) return;
  const domaine = volDomaineComplet();
  const xMin = volZoomMin ?? domaine.min;
  const xMax = volZoomMax ?? domaine.max;

  dessinerAltitudeVol(volCanvases.alt, xMin, xMax);
  dessinerSonVol(volCanvases.son, xMin, xMax);
  dessinerAccelVol(volCanvases.accel, xMin, xMax);
  mettreAJourCarteVol();
}

function dessinerSonVol(canvas, xMin, xMax) {
  const series = [];
  for (let v = 0; v < resultatsBase.length; v++) {
    const r = resultatsBase[v];
    series.push({ xs: r.temporel.temps.map(t => t/60), ys: r.temporel.niveaux, couleur: PALETTE_VOIES[v], label: nomVoie(v) });
  }
  tracerCourbe(canvas, series, {
    titre: "Niveau sonore, LAeq court terme (1 s), 4 voies",
    xlabel: "temps (min)", ylabel: `niveau (${uniteCourante()})`,
    xMin, xMax,
  });
}

function dessinerAccelVol(canvas, xMin, xMax) {
  const labels = ["Téléphone esclave 1", "Téléphone esclave 2"];
  const couleurs = ["#0f4c5c", "#c98a3b"];
  const series = [];
  for (let i = 0; i < 2; i++) {
    if (!volAccel[i]) continue;
    const decalage = volDecalages["accel"+i];
    series.push({ xs: volAccel[i].temps.map(t => (t+decalage)/60), ys: volAccel[i].magnitude, couleur: couleurs[i], label: labels[i] });
  }
  if (!series.length) {
    const { ctx, w, h } = preparerCanvas(canvas);
    ctx.clearRect(0,0,w,h);
    ctx.font = "13px sans-serif"; ctx.fillStyle = "#20242b";
    ctx.fillText("Accélération linéaire (magnitude), 2 téléphones", 52, 16);
    ctx.fillStyle = "#5b6270";
    ctx.fillText("Déposez un export accéléromètre phyphox ci-dessus pour afficher cette courbe.", 52, h/2);
    return;
  }
  tracerCourbe(canvas, series, {
    titre: "Accélération linéaire (magnitude), 2 téléphones",
    xlabel: "temps (min)", ylabel: "accélération (m/s²)",
    xMin, xMax,
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
    if (xs[i] < xMin || xs[i] > xMax || ys[i] === null || !isFinite(ys[i])) { started = false; continue; }
    const x = px(xs[i]), y = py(ys[i]);
    if (!started) { ctx.moveTo(x,y); started = true; } else ctx.lineTo(x,y);
  }
  ctx.stroke();
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

  const pts = volGps.lat.map((lat,i) => ({ lat, lon: volGps.lon[i], alt: volGps.alt[i], t: (volGps.temps[i]+volDecalages.gps)/60 }));

  let aMin = Infinity, aMax = -Infinity;
  for (const p of pts) if (p.alt !== null && isFinite(p.alt)) { if (p.alt<aMin) aMin=p.alt; if (p.alt>aMax) aMax=p.alt; }
  const altOk = isFinite(aMin) && isFinite(aMax) && aMax > aMin;

  for (let i = 0; i < pts.length-1; i++) {
    const t = altOk ? (((pts[i].alt+pts[i+1].alt)/2)-aMin)/(aMax-aMin) : 0.5;
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

  let aMin = Infinity, aMax = -Infinity;
  for (const p of pts) if (p.alt !== null && isFinite(p.alt)) { if (p.alt<aMin) aMin=p.alt; if (p.alt>aMax) aMax=p.alt; }
  const altOk = isFinite(aMin) && isFinite(aMax) && aMax > aMin;

  let placemarks = "";
  for (let i = 0; i < pts.length-1; i++) {
    const t = altOk ? (((pts[i].alt+pts[i+1].alt)/2)-aMin)/(aMax-aMin) : 0.5;
    const [r,g,b] = viridisRGB(t);
    const alt1 = altOk ? pts[i].alt : 0, alt2 = altOk ? pts[i+1].alt : 0;
    placemarks += `
    <Placemark>
      <Style><LineStyle><color>${couleurKmlDepuisRgb(r,g,b)}</color><width>4</width></LineStyle></Style>
      <LineString>
        <altitudeMode>${altOk ? "absolute" : "clampToGround"}</altitudeMode>
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
