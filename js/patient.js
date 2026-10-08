"use strict";
/* =========================================================================
   PATIENT.JS — onglet "Exposition patient" : ce qui parvient a l'enfant
   (nouveau-ne en couveuse, enfant sur brancard) pendant le transport.

   Trois blocs, calcules sur une periode choisie (minutes, temps du WAV) :

   1. Bruit : attenuation apportee par la couveuse (ou l'environnement de
      l'enfant) entre un micro "exterieur" (cellule) et un micro "interieur"
      (pres de la tete de l'enfant). Tiers d'octave non ponderes, LAeq par
      minute. Les deux voies sont enregistrees par le meme Teensy, donc
      synchrones a l'echantillon pres.

   2. Vibrations : transmissibilite entre un telephone pose sur le plancher
      et un telephone pose sur le support de l'enfant (matelas, brancard).
      Meme definition que Gibb et al. (2025, AHFE, vol. 186, p. 178-188) :
      T(f) = PSD_sortie / PSD_entree, le plancher etant l'entree, PSD par la
      methode de Welch avec une resolution proche de 1 Hz. Les telephones ne
      sont synchronises qu'a environ une seconde pres (decalages reglés dans
      l'onglet Trajet) : on compare des spectres moyennes, pas une fonction
      de transfert complexe (pas de coherence, pas de phase).

   3. Confort et chocs (indicatif) : acceleration ponderee ISO 2631-1
      (Wk sur l'axe vertical declare, Wd sur les deux autres, facteurs k = 1),
      valeur totale par minute placee sur l'echelle de confort de l'annexe C,
      VDV, MTVV, facteur de crete, et comptage d'evenements au-dessus d'un
      seuil choisi par l'utilisateur. ISO 2631-1 est etablie sur des adultes :
      pour un nouveau-ne, ces valeurs servent a comparer des phases, des
      vehicules ou des supports, pas a juger un risque.

   Les accelerometres sont ceux deposes dans l'onglet Trajet (meme tableau
   volAccel, memes decalages volDecalages.accel) : il faut l'export
   "Acceleration lineaire" (sans g) avec ses trois axes. La magnitude seule
   ne convient pas a une analyse spectrale (signal redresse).
   ========================================================================= */

const PAT_G0 = 9.80665;
const PAT_NOMS_AXES = ["x", "y", "z"];

// Parametres des ponderations frequentielles d'ISO 2631-1 (annexe A).
// Verifies dans le code (test pondérations) contre les valeurs tabulees de la
// norme : Wk(1 Hz) = 0,482 ; Wk(6,3 Hz) = 1,054 ; Wd(1 Hz) = 1,011 ; etc.
const PAT_WK = { f1: 0.4, f2: 100, f3: 12.5, f4: 12.5, Q4: 0.63, f5: 2.37, Q5: 0.91, f6: 3.35, Q6: 0.91 };
const PAT_WD = { f1: 0.4, f2: 100, f3: 2.0, f4: 2.0, Q4: 0.63 };

// Echelle de confort d'ISO 2631-1:1997, annexe C (valeur totale ponderee,
// m/s²). Les plages publiees se chevauchent ; une valeur est rangee dans la
// classe la MOINS severe dont la plage la contient, d'ou les bornes
// superieures ci-dessous (0,315 ; 0,63 ; 1 ; 1,6 ; 2,5).
const PAT_CLASSES_CONFORT = [
  { max: 0.315,    nom: "pas inconfortable",          plage: "< 0,315",      couleur: "#2e8b57" },
  { max: 0.63,     nom: "un peu inconfortable",       plage: "0,315 à 0,63", couleur: "#8db63c" },
  { max: 1.0,      nom: "assez inconfortable",        plage: "0,5 à 1",      couleur: "#d4a72c" },
  { max: 1.6,      nom: "inconfortable",              plage: "0,8 à 1,6",    couleur: "#e07b2e" },
  { max: 2.5,      nom: "très inconfortable",         plage: "1,25 à 2,5",   couleur: "#c8452a" },
  { max: Infinity, nom: "extrêmement inconfortable",  plage: "> 2",          couleur: "#8c1c1c" },
];

let patRoles = { micInt: null, micExt: null, accSupport: null, accPlancher: null, vertSupport: 2, vertPlancher: 2 };
let patPeriode = { debut: null, fin: null };   // minutes ; null = debut / fin du WAV
let patModeAxes = "somme";                      // "somme" (3 axes) | "vertical"
let patFacteurChoc = 6;                         // seuil = facteur x RMS pondere vertical
let patResultats = null;
let patCalculEnCours = false;

/* ================================================================ calculs */

function patClasseConfort(a) {
  if (a < PAT_CLASSES_CONFORT[0].max) return 0;   // "moins de 0,315"
  for (let i = 1; i < PAT_CLASSES_CONFORT.length; i++) if (a <= PAT_CLASSES_CONFORT[i].max) return i;
  return PAT_CLASSES_CONFORT.length - 1;
}

// Reponse complexe H(j2πf) d'une ponderation ISO 2631-1 : passe-haut et
// passe-bas de limitation de bande (Butterworth 2e ordre), transition
// acceleration-vitesse, et marche montante (Wk seulement).
function patReponsePonderation(f, p) {
  const w = 2 * Math.PI * f;
  const mul = (a, b) => [a[0]*b[0] - a[1]*b[1], a[0]*b[1] + a[1]*b[0]];
  const div = (a, b) => { const d = b[0]*b[0] + b[1]*b[1]; return [(a[0]*b[0] + a[1]*b[1]) / d, (a[1]*b[0] - a[0]*b[1]) / d]; };
  const s = [0, w], s2 = [-w*w, 0];
  const Q1 = 1 / Math.SQRT2;
  const w1 = 2*Math.PI*p.f1, w2 = 2*Math.PI*p.f2, w3 = 2*Math.PI*p.f3, w4 = 2*Math.PI*p.f4;
  let h = div(s2, [s2[0] + w1*w1, s[1]*w1/Q1]);
  h = mul(h, div([w2*w2, 0], [s2[0] + w2*w2, s[1]*w2/Q1]));
  h = mul(h, div([1, w/w3], [1 - w*w/(w4*w4), w/(p.Q4*w4)]));
  if (p.f5) {
    const w5 = 2*Math.PI*p.f5, w6 = 2*Math.PI*p.f6;
    const k = (w5*w5) / (w6*w6);
    const hs = div([1 - w*w/(w5*w5), w/(p.Q5*w5)], [1 - w*w/(w6*w6), w/(p.Q6*w6)]);
    h = mul(h, [hs[0]*k, hs[1]*k]);
  }
  return h;
}

function patModulePonderation(f, p) { const h = patReponsePonderation(f, p); return Math.hypot(h[0], h[1]); }

function patPow2Au(n) { let p = 1; while (p < n) p *= 2; return p; }

// Frequence d'echantillonnage effective d'un export phyphox : inverse de
// l'intervalle median (les intervalles d'un capteur de telephone ne sont pas
// parfaitement reguliers).
function patFsMedian(temps) {
  const n = Math.min(temps.length - 1, 20000);
  const dts = [];
  const pas = Math.max(1, Math.floor((temps.length - 1) / n));
  for (let i = 0; i + 1 < temps.length; i += pas) { const d = temps[i+1] - temps[i]; if (d > 0) dts.push(d); }
  dts.sort((a, b) => a - b);
  return dts.length ? 1 / dts[Math.floor(dts.length / 2)] : NaN;
}

// Interruptions d'enregistrement : intervalles > max(0,2 s ; 10 periodes).
function patNombreTrous(temps, fs) {
  const seuil = Math.max(0.2, 10 / fs);
  let n = 0;
  for (let i = 0; i + 1 < temps.length; i++) if (temps[i+1] - temps[i] > seuil) n++;
  return n;
}

// Reechantillonnage lineaire sur une grille reguliere [t0, t1) au pas 1/fs,
// en temps WAV (temps du telephone + decalage).
function patReechantillonner(temps, valeurs, decalage, t0, t1, fs) {
  const n = Math.max(0, Math.floor((t1 - t0) * fs));
  const out = new Float64Array(n);
  let j = 0;
  const N = temps.length;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fs - decalage;
    while (j + 1 < N && temps[j+1] < t) j++;
    if (j + 1 >= N) { out[i] = valeurs[N-1]; continue; }
    const ta = temps[j], tb = temps[j+1];
    if (t <= ta) { out[i] = valeurs[j]; continue; }
    const r = (t - ta) / (tb - ta);
    out[i] = valeurs[j] + r * (valeurs[j+1] - valeurs[j]);
  }
  return out;
}

// DSP unilaterale par la methode de Welch : fenetre de Hann, recouvrement
// 50 %, moyenne retiree par segment. Unite : (m/s²)²/Hz.
function patWelch(x, fs, nperseg) {
  if (x.length < nperseg) return null;
  const { w, winPower } = genererFenetre("hann", nperseg);
  const pas = nperseg / 2;
  const nb = nperseg / 2 + 1;
  const psd = new Float64Array(nb);
  const re = new Float64Array(nperseg), im = new Float64Array(nperseg);
  let nSeg = 0;
  for (let debut = 0; debut + nperseg <= x.length; debut += pas) {
    let m = 0;
    for (let i = 0; i < nperseg; i++) m += x[debut + i];
    m /= nperseg;
    for (let i = 0; i < nperseg; i++) { re[i] = (x[debut + i] - m) * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < nb; k++) {
      let p = (re[k]*re[k] + im[k]*im[k]) / (fs * winPower);
      if (k > 0 && k < nperseg / 2) p *= 2;
      psd[k] += p;
    }
    nSeg++;
  }
  for (let k = 0; k < nb; k++) psd[k] /= nSeg;
  const freqs = new Float64Array(nb);
  for (let k = 0; k < nb; k++) freqs[k] = k * fs / nperseg;
  return { freqs, psd, df: fs / nperseg, nSeg, nperseg };
}

// Valeur efficace dans une bande, par integration de la DSP.
function patRmsBande(w, fBas, fHaut) {
  let s = 0;
  for (let k = 0; k < w.freqs.length; k++) if (w.freqs[k] >= fBas && w.freqs[k] <= fHaut) s += w.psd[k] * w.df;
  return Math.sqrt(s);
}

// Signal pondere (ISO 2631-1) calcule dans le domaine frequentiel : FFT du
// signal complet (moyenne retiree, complete par des zeros pour eviter le
// repliement circulaire de la reponse impulsionnelle), produit par H(f),
// FFT inverse. Reponse en amplitude ET en phase de la norme, donc
// utilisable pour la VDV et la MTVV.
function patPonderer(x, fs, p) {
  const N = x.length;
  const M = patPow2Au(N + Math.ceil(20 * fs));
  const re = new Float64Array(M), im = new Float64Array(M);
  let m = 0;
  for (let i = 0; i < N; i++) m += x[i];
  m /= N || 1;
  for (let i = 0; i < N; i++) re[i] = x[i] - m;
  fft(re, im);
  for (let k = 0; k <= M / 2; k++) {
    const [hr, hi] = patReponsePonderation(Math.max(k * fs / M, 1e-9), p);
    const a = re[k], b = im[k];
    re[k] = a*hr - b*hi; im[k] = a*hi + b*hr;
    if (k > 0 && k < M / 2) {
      const c = re[M-k], d = im[M-k];       // composante negative : conjugue de H
      re[M-k] = c*hr + d*hi; im[M-k] = d*hr - c*hi;
    }
  }
  for (let i = 0; i < M; i++) im[i] = -im[i];
  fft(re, im);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = re[i] / M;
  return out;
}

function patRms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]*x[i]; return x.length ? Math.sqrt(s / x.length) : NaN; }
function patVdv(x, fs) { let s = 0; for (let i = 0; i < x.length; i++) { const v = x[i]*x[i]; s += v*v; } return Math.pow(s / fs, 0.25); }
function patPic(x) { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; }

// MTVV : maximum de la valeur efficace glissante, integration lineaire sur
// 1 s (ISO 2631-1, 6.3.1).
function patMtvv(x, fs) {
  const L = Math.max(1, Math.round(fs));
  if (x.length < L) return patRms(x);
  let s = 0, mx = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]*x[i];
    if (i >= L) s -= x[i-L]*x[i-L];
    if (i >= L - 1) { const v = s / L; if (v > mx) mx = v; }
  }
  return Math.sqrt(Math.max(mx, 0));
}

// Evenements au-dessus d'un seuil : un evenement commence au premier
// echantillon au-dessus du seuil et se termine apres 1 s sans depassement.
function patDetecterChocs(x, fs, t0, seuil) {
  const evts = [];
  const garde = Math.round(fs);
  let cour = null;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > seuil) {
      if (cour && i - cour.dernier <= garde) {
        cour.dernier = i;
        if (a > cour.pic) { cour.pic = a; cour.iPic = i; }
      } else {
        if (cour) evts.push(cour);
        cour = { debut: i, dernier: i, pic: a, iPic: i };
      }
    }
  }
  if (cour) evts.push(cour);
  return evts.map(e => ({ t: t0 + e.iPic / fs, pic: e.pic }));
}

function patSecondesTelephone(i) {
  const acc = volAccel[i];
  const dec = volDecalages.accel[i] || 0;
  return { debut: acc.temps[0] + dec, fin: acc.temps[acc.temps.length - 1] + dec, dec };
}

// Analyse d'un telephone sur [t0, t1] (secondes, temps WAV).
function patAnalyserTelephone(i, t0, t1, axeVert) {
  const acc = volAccel[i];
  if (!acc) return { erreur: "fichier absent" };
  if (!acc.axes) return { erreur: `${acc.nomFichier} ne contient pas les trois axes x, y, z : l'analyse spectrale demande l'export "Accélération linéaire" complet, pas la seule magnitude.` };
  const { debut, fin, dec } = patSecondesTelephone(i);
  const tA = Math.max(t0, debut), tB = Math.min(t1, fin);
  if (tB - tA < 10) return { erreur: `${acc.nomFichier} : moins de 10 s en commun avec la période choisie (vérifiez le décalage dans l'onglet Trajet).` };
  const fs = patFsMedian(acc.temps);
  const signaux = acc.axes.map(v => patReechantillonner(acc.temps, v, dec, tA, tB, fs));
  const nperseg = patPow2Au(fs);
  const fHaut = Math.min(80, 0.9 * fs / 2);

  const welch = signaux.map(s => patWelch(s, fs, nperseg));
  const rms120 = welch.map(w => patRmsBande(w, 1, 20));
  const rmsLarge = welch.map(w => patRmsBande(w, 1, fHaut));

  const ponderes = signaux.map((s, a) => patPonderer(s, fs, a === axeVert ? PAT_WK : PAT_WD));
  const aw = ponderes.map(patRms);
  const av = Math.sqrt(aw.reduce((s, v) => s + v*v, 0));
  const vdv = ponderes.map(p => patVdv(p, fs));
  const vdvTotal = Math.pow(vdv.reduce((s, v) => s + Math.pow(v, 4), 0), 0.25);
  const mtvv = ponderes.map(p => patMtvv(p, fs));
  const crete = ponderes.map((p, a) => patPic(p) / aw[a]);
  const duree = (tB - tA);

  // Valeur totale ponderee par minute (blocs de 60 s ; dernier bloc garde
  // s'il dure au moins 30 s).
  const L = Math.round(60 * fs);
  const minutes = { xs: [], av: [], durees: [] };
  for (let d = 0; d < signaux[0].length; d += L) {
    const f = Math.min(d + L, signaux[0].length);
    if (f - d < 30 * fs) break;
    let s = 0;
    for (const p of ponderes) for (let k = d; k < f; k++) s += p[k]*p[k];
    minutes.av.push(Math.sqrt(s / (f - d)));
    minutes.xs.push((tA + (d + f) / 2 / fs) / 60);
    minutes.durees.push((f - d) / fs);
  }

  return {
    nomFichier: acc.nomFichier, fs, tA, tB, duree, nperseg, df: fs / nperseg, fHaut,
    trous: patNombreTrous(acc.temps, fs), axeVert,
    welch, rms120, rmsLarge, aw, av, vdv, vdvTotal, mtvv, crete, minutes,
    vertical: ponderes[axeVert],
  };
}

// Transmissibilite plancher -> support : les deux telephones reechantillonnes
// sur la meme grille (fs = la plus basse des deux), periode commune.
function patTransmissibilite(iSup, iPla, t0, t1, vertSup, vertPla) {
  const a = volAccel[iSup], b = volAccel[iPla];
  if (!a || !b || !a.axes || !b.axes) return null;
  const pa = patSecondesTelephone(iSup), pb = patSecondesTelephone(iPla);
  const tA = Math.max(t0, pa.debut, pb.debut), tB = Math.min(t1, pa.fin, pb.fin);
  if (tB - tA < 10) return { erreur: "Les deux téléphones ont moins de 10 s d'enregistrement en commun sur la période choisie (vérifiez les décalages dans l'onglet Trajet)." };
  const fs = Math.min(patFsMedian(a.temps), patFsMedian(b.temps));
  const nperseg = patPow2Au(fs);
  const welchSup = a.axes.map(v => patWelch(patReechantillonner(a.temps, v, pa.dec, tA, tB, fs), fs, nperseg));
  const welchPla = b.axes.map(v => patWelch(patReechantillonner(b.temps, v, pb.dec, tA, tB, fs), fs, nperseg));
  const nb = welchSup[0].psd.length;
  const somme = (ws) => { const s = new Float64Array(nb); for (const w of ws) for (let k = 0; k < nb; k++) s[k] += w.psd[k]; return s; };
  const fHaut = Math.min(80, 0.9 * fs / 2);
  return {
    fs, tA, tB, df: fs / nperseg, fHaut, freqs: welchSup[0].freqs, nSeg: welchSup[0].nSeg,
    somme: { sup: somme(welchSup), pla: somme(welchPla) },
    vertical: { sup: welchSup[vertSup].psd, pla: welchPla[vertPla].psd },
  };
}

// Bruit : tiers d'octave non ponderes (corriges de la reponse du micro) et
// LAeq, interieur et exterieur, sur [t0, t1].
function patAnalyserBruit(vInt, vExt, t0, t1) {
  const fs = wavData.fs;
  const i0 = Math.max(0, Math.floor(t0 * fs)), i1 = Math.min(wavData.canaux[0].length, Math.floor(t1 * fs));
  function voie(v) {
    const r = resultatsBase[v];
    const extrait = r.pression.subarray(i0, i1);
    const params = { nperseg: Math.min(pow2Below(fs), pow2Below(extrait.length)), recouvrement: 50, fenetre: "hann" };
    const { freqs, psd, df } = calculerPsd(extrait, fs, params);
    const psdC = new Float64Array(psd.length);
    for (let k = 0; k < psd.length; k++) psdC[k] = psd[k] * Math.pow(10, -correctionMicroDb(freqs[k]) / 10);
    const bandes = tiersOctave(freqs, psdC, df, null, r.pref);
    // LAeq de la periode et par minute, depuis le niveau court terme (1 s)
    // deja calcule par l'analyse principale.
    const { temps, niveaux } = r.temporel;
    let s = 0, n = 0;
    const parMinute = new Map();
    for (let k = 0; k < temps.length; k++) {
      if (temps[k] < t0 || temps[k] > t1 || !isFinite(niveaux[k])) continue;
      const e = Math.pow(10, niveaux[k] / 10);
      s += e; n++;
      const m = Math.floor((temps[k] - t0) / 60);
      const c = parMinute.get(m) || { s: 0, n: 0 };
      c.s += e; c.n++; parMinute.set(m, c);
    }
    const minutes = { xs: [], laeq: [] };
    for (const [m, c] of [...parMinute.entries()].sort((a, b) => a[0] - b[0])) {
      if (c.n < 30) continue;
      minutes.xs.push((t0 + (m + 0.5) * 60) / 60);
      minutes.laeq.push(10 * Math.log10(c.s / c.n));
    }
    return { voie: v, calibre: r.calibre, bandes, laeq: n ? 10 * Math.log10(s / n) : NaN, minutes };
  }
  const int = voie(vInt), ext = voie(vExt);
  const fMax = fs / 2;
  const bandesValides = FREQ_TIERS_OCTAVE.map((fc, k) => ({ fc, k })).filter(({ fc, k }) =>
    fc * Math.pow(2, 1/6) <= fMax && isFinite(int.bandes[k]) && isFinite(ext.bandes[k]));
  return { int, ext, bandesValides };
}

function patPeriodeSecondes() {
  const duree = wavData.dureeS;
  let d = patPeriode.debut === null ? 0 : patPeriode.debut * 60;
  let f = patPeriode.fin === null ? duree : patPeriode.fin * 60;
  d = Math.max(0, Math.min(d, duree)); f = Math.max(0, Math.min(f, duree));
  return { t0: Math.min(d, f), t1: Math.max(d, f) };
}

async function calculerExpositionPatient() {
  const { t0, t1 } = patPeriodeSecondes();
  const res = { wav: wavData, base: resultatsBase, t0, t1, bruit: null, erreurBruit: null, support: null, plancher: null, transmission: null };
  if (t1 - t0 < 10) { res.erreurBruit = "Période trop courte (moins de 10 s)."; return res; }

  const { micInt, micExt, accSupport, accPlancher, vertSupport, vertPlancher } = patRoles;
  if (micInt !== null && micExt !== null && micInt !== micExt && resultatsBase[micInt] && resultatsBase[micExt]) {
    res.bruit = patAnalyserBruit(micInt, micExt, t0, t1);
  } else if (micInt !== null && micExt !== null && micInt === micExt) {
    res.erreurBruit = "Choisissez deux voies différentes pour l'intérieur et l'extérieur.";
  }
  await cederAuNavigateur();
  if (accSupport !== null && volAccel[accSupport]) res.support = patAnalyserTelephone(accSupport, t0, t1, vertSupport);
  await cederAuNavigateur();
  if (accPlancher !== null && volAccel[accPlancher] && accPlancher !== accSupport) res.plancher = patAnalyserTelephone(accPlancher, t0, t1, vertPlancher);
  await cederAuNavigateur();
  if (res.support && res.plancher && !res.support.erreur && !res.plancher.erreur) {
    res.transmission = patTransmissibilite(accSupport, accPlancher, t0, t1, vertSupport, vertPlancher);
  }
  return res;
}

/* ================================================================ interface */

function patFormat(v, dec) { return isFinite(v) ? v.toFixed(dec).replace(".", ",") : "—"; }
function patMinSec(sec) {
  const s = Math.round(sec), m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}

function patElement(tag, classe, texte) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texte !== undefined) e.textContent = texte;
  return e;
}

function patSelect(options, valeur, onChange) {
  const sel = document.createElement("select");
  for (const [val, lib] of options) {
    const o = document.createElement("option");
    o.value = val === null ? "" : String(val); o.textContent = lib;
    sel.appendChild(o);
  }
  sel.value = valeur === null ? "" : String(valeur);
  sel.addEventListener("change", () => onChange(sel.value === "" ? null : parseInt(sel.value, 10)));
  return sel;
}

function patLabel(texte, controle) {
  const l = patElement("label");
  l.appendChild(document.createTextNode(texte));
  l.appendChild(controle);
  return l;
}

function rendreOngletPatient(conteneur) {
  conteneur.innerHTML = "";
  conteneur.appendChild(creerTitreImpression("Exposition patient"));

  const intro = patElement("p", "note");
  intro.textContent = "Ce que reçoit l'enfant pendant le transport : bruit atténué (ou non) par la couveuse, vibrations transmises par le support (matelas, brancard), et confort vibratoire indicatif. " +
    "Attribuez un rôle aux micros et aux téléphones, choisissez la période, puis lancez le calcul.";
  conteneur.appendChild(intro);

  conteneur.appendChild(patPanneauReglages());

  const res = patResultats && patResultats.wav === wavData && patResultats.base === resultatsBase ? patResultats : null;
  if (!res) return;

  const periode = patElement("p", "note");
  periode.textContent = `Période analysée : de ${patFormat(res.t0/60, 1)} à ${patFormat(res.t1/60, 1)} min (temps du WAV), soit ${patMinSec(res.t1 - res.t0)}.`;
  conteneur.appendChild(periode);

  conteneur.appendChild(patSectionBruit(res));
  conteneur.appendChild(patSectionVibrations(res));
  conteneur.appendChild(patSectionConfort(res));
}

function patPanneauReglages() {
  const wrap = patElement("div", "pat-reglages no-print");
  const voies = voiesAnalysees();
  const optVoies = [[null, "aucune"], ...voies.map(v => [v, nomVoie(v)])];
  const telephones = [];
  for (let i = 0; i < volAccel.length; i++) if (volAccel[i]) telephones.push(i);
  const optTel = [[null, "aucun"], ...telephones.map(i => [i, `Téléphone esclave ${i+1} (${volAccel[i].nomFichier})`])];
  const optAxes = PAT_NOMS_AXES.map((n, a) => [a, `axe ${n} du téléphone`]);

  const grille = patElement("div", "pat-grille");
  grille.appendChild(patLabel("Micro intérieur (près de la tête de l'enfant, dans la couveuse)", patSelect(optVoies, patRoles.micInt, v => { patRoles.micInt = v; })));
  grille.appendChild(patLabel("Micro extérieur (cellule, hors couveuse)", patSelect(optVoies, patRoles.micExt, v => { patRoles.micExt = v; })));
  grille.appendChild(patLabel("Téléphone sur le support de l'enfant (matelas, brancard)", patSelect(optTel, patRoles.accSupport, v => { patRoles.accSupport = v; })));
  grille.appendChild(patLabel("Axe vertical de ce téléphone", patSelect(optAxes, patRoles.vertSupport, v => { patRoles.vertSupport = v; })));
  grille.appendChild(patLabel("Téléphone sur le plancher du véhicule", patSelect(optTel, patRoles.accPlancher, v => { patRoles.accPlancher = v; })));
  grille.appendChild(patLabel("Axe vertical de ce téléphone", patSelect(optAxes, patRoles.vertPlancher, v => { patRoles.vertPlancher = v; })));

  const duree = wavData.dureeS / 60;
  const inDebut = document.createElement("input");
  inDebut.type = "number"; inDebut.step = "0.1"; inDebut.min = "0"; inDebut.max = duree.toFixed(1);
  inDebut.value = (patPeriode.debut ?? 0).toFixed(1);
  inDebut.addEventListener("input", () => { const v = parseFloat(inDebut.value); patPeriode.debut = isFinite(v) ? v : null; });
  const inFin = document.createElement("input");
  inFin.type = "number"; inFin.step = "0.1"; inFin.min = "0"; inFin.max = duree.toFixed(1);
  inFin.value = (patPeriode.fin ?? duree).toFixed(1);
  inFin.addEventListener("input", () => { const v = parseFloat(inFin.value); patPeriode.fin = isFinite(v) ? v : null; });
  grille.appendChild(patLabel("Début de la période (min)", inDebut));
  grille.appendChild(patLabel("Fin de la période (min)", inFin));
  wrap.appendChild(grille);

  if (!telephones.length) {
    const p = patElement("p", "note");
    p.textContent = "Aucun export accéléromètre chargé. Les téléphones se déposent dans l'onglet Trajet (zones \"téléphone esclave\"), avec leur décalage ; ils sont repris ici automatiquement. Export attendu : \"Accélération linéaire\" (sans g) avec les trois axes.";
    wrap.appendChild(p);
    const btn = patElement("button", "secondaire", "Aller à l'onglet Trajet");
    btn.type = "button";
    btn.addEventListener("click", () => activerOnglet("vol"));
    wrap.appendChild(btn);
  }

  const ligne = patElement("div", "pat-actions");
  const btnCalc = patElement("button", "principal", patCalculEnCours ? "Calcul en cours…" : "Calculer");
  btnCalc.type = "button"; btnCalc.id = "btnCalculPatient";
  btnCalc.disabled = patCalculEnCours;
  btnCalc.addEventListener("click", async () => {
    patCalculEnCours = true;
    btnCalc.disabled = true; btnCalc.textContent = "Calcul en cours…";
    await attendreProchaineImage();
    try {
      patResultats = await calculerExpositionPatient();
    } catch (err) {
      console.error(err);
      alert("Erreur pendant le calcul de l'exposition patient : " + (err && err.message ? err.message : String(err)));
    } finally {
      patCalculEnCours = false;
    }
    if (ongletActif === "patient") activerOnglet("patient");
  });
  ligne.appendChild(btnCalc);
  wrap.appendChild(ligne);
  return wrap;
}

/* ---------------------------------------------------------------- bruit */
function patSectionBruit(res) {
  const sec = patElement("div", "pat-section");
  sec.appendChild(patElement("h3", null, "1. Bruit : ce que la couveuse laisse passer"));
  if (res.erreurBruit) { sec.appendChild(patElement("div", "avertissement", res.erreurBruit)); return sec; }
  if (!res.bruit) { sec.appendChild(patElement("p", "note", "Choisissez un micro intérieur et un micro extérieur pour cette partie.")); return sec; }

  const { int, ext, bandesValides } = res.bruit;
  const memeUnite = int.calibre === ext.calibre;
  const unite = int.calibre && ext.calibre ? "dB SPL" : "dBFS";
  if (!memeUnite) {
    sec.appendChild(patElement("div", "avertissement", "Une seule des deux voies est étalonnée : les niveaux ne sont pas dans la même unité et l'atténuation ne peut pas être calculée. Renseignez l'étalonnage des deux voies dans le fichier .TXT."));
    return sec;
  }
  if (!int.calibre) {
    sec.appendChild(patElement("div", "avertissement", "Voies non étalonnées (dBFS) : l'atténuation affichée suppose deux micros et deux chaînes d'acquisition de même sensibilité. Elle n'est fiable qu'avec l'étalonnage des deux voies."));
  }

  const table = document.createElement("table");
  table.className = "pat-table";
  const diffA = ext.laeq - int.laeq;
  table.innerHTML = `<thead><tr><th>Grandeur</th><th>Intérieur (${nomVoie(int.voie)})</th><th>Extérieur (${nomVoie(ext.voie)})</th><th>Extérieur − intérieur</th></tr></thead>
    <tbody><tr><td>LAeq sur la période (${unite.replace("dB", "dB(A)")})</td><td>${patFormat(int.laeq, 1)}</td><td>${patFormat(ext.laeq, 1)}</td><td>${patFormat(diffA, 1)} dB</td></tr></tbody>`;
  sec.appendChild(table);

  const xs = bandesValides.map(b => b.fc);
  const yInt = bandesValides.map(b => int.bandes[b.k]);
  const yExt = bandesValides.map(b => ext.bandes[b.k]);
  const yAtt = bandesValides.map(b => ext.bandes[b.k] - int.bandes[b.k]);
  const base = baseNomFichier();
  const xMin = 20, xMax = xs.length ? xs[xs.length - 1] * Math.pow(2, 1/6) : 20000;

  sec.appendChild(creerBlocGraphique("pat-tiers", "Tiers d'octave, non pondérés", (canvas) => {
    tracerCourbe(canvas, [
      { xs, ys: yExt, couleur: "#c98a3b", label: `extérieur (${nomVoie(ext.voie)})` },
      { xs, ys: yInt, couleur: "#0f4c5c", label: `intérieur (${nomVoie(int.voie)})` },
    ], { titre: "Niveaux par tiers d'octave, non pondérés, corrigés de la réponse du micro", xlabel: "fréquence centrale (Hz)", ylabel: `niveau (${unite})`, logX: true, xMin, xMax, formatX: formatHz });
  }, () => `${base}_patient_tiers-octave.png`));

  sec.appendChild(creerBlocGraphique("pat-attenuation", "Atténuation par bande", (canvas) => {
    tracerCourbe(canvas, [{ xs, ys: yAtt, couleur: "#7a3b8a" }],
      { titre: "Atténuation par tiers d'octave (extérieur − intérieur) ; négatif = plus de bruit dedans", xlabel: "fréquence centrale (Hz)", ylabel: "atténuation (dB)", logX: true, xMin, xMax, formatX: formatHz,
        lignesH: [{ y: 0, couleur: "#20242b" }] });
  }, () => `${base}_patient_attenuation.png`));

  if (int.minutes.xs.length) {
    sec.appendChild(creerBlocGraphique("pat-laeq-minute", "LAeq par minute", (canvas) => {
      tracerCourbe(canvas, [
        { xs: ext.minutes.xs, ys: ext.minutes.laeq, couleur: "#c98a3b", label: "extérieur" },
        { xs: int.minutes.xs, ys: int.minutes.laeq, couleur: "#0f4c5c", label: "intérieur" },
      ], { titre: "LAeq par minute, intérieur et extérieur", xlabel: "temps (min)", ylabel: `LAeq (${unite.replace("dB", "dB(A)")})`, decimalesYAuto: true });
    }, () => `${base}_patient_laeq-minute.png`));
  }

  sec.appendChild(patElement("p", "note",
    "Une atténuation négative dans une bande signifie qu'il y a plus de bruit dans la couveuse qu'à l'extérieur dans cette bande : bruit propre de la couveuse (ventilation, chauffage) ou son transmis par la structure (vibrations du support). " +
    "Les tiers d'octave sont calculés sur le spectre en bande fine corrigé de la réponse du micro, comme dans les onglets Voie."));
  return sec;
}

/* ---------------------------------------------------------------- vibrations */
function patTableTelephones(res) {
  const lignes = [];
  for (const [role, r] of [["Support", res.support], ["Plancher", res.plancher]]) {
    if (!r || r.erreur) continue;
    const vec = (arr) => Math.sqrt(arr.reduce((s, v) => s + v*v, 0));
    const cell = (v) => `${patFormat(v, 3)} m/s² <span class="note">(${patFormat(v / PAT_G0, 4)} g)</span>`;
    lignes.push(`<tr><td>${role}</td><td>${r.nomFichier}</td><td>${patFormat(r.fs, 0)} Hz</td>` +
      PAT_NOMS_AXES.map((_, a) => `<td>${cell(r.rms120[a])}</td>`).join("") + `<td>${cell(vec(r.rms120))}</td>` +
      `<td>${cell(vec(r.rmsLarge))}</td></tr>`);
  }
  if (!lignes.length) return null;
  const t = document.createElement("table");
  t.className = "pat-table";
  const fH = (res.support && !res.support.erreur ? res.support : res.plancher).fHaut;
  t.innerHTML = `<thead><tr><th>Position</th><th>Fichier</th><th>Fréq. éch.</th><th>RMS x, 1 à 20 Hz</th><th>RMS y, 1 à 20 Hz</th><th>RMS z, 1 à 20 Hz</th><th>RMS 3 axes, 1 à 20 Hz</th><th>RMS 3 axes, 1 à ${patFormat(fH, 0)} Hz</th></tr></thead><tbody>${lignes.join("")}</tbody>`;
  return t;
}

function patSectionVibrations(res) {
  const sec = patElement("div", "pat-section");
  sec.appendChild(patElement("h3", null, "2. Vibrations : ce que le support transmet à l'enfant"));
  for (const r of [res.support, res.plancher]) if (r && r.erreur) sec.appendChild(patElement("div", "avertissement", r.erreur));
  if (!res.support && !res.plancher) {
    sec.appendChild(patElement("p", "note", "Choisissez au moins un téléphone (support et plancher pour la transmissibilité)."));
    return sec;
  }
  const table = patTableTelephones(res);
  if (table) sec.appendChild(table);
  sec.appendChild(patElement("p", "note",
    "Valeurs efficaces non pondérées, obtenues en intégrant la densité spectrale de puissance dans la bande indiquée. Bandes choisies comme Gibb et al. (2025) : 1 à 20 Hz, et une bande large limitée ici par la fréquence d'échantillonnage du téléphone (ils utilisaient 1 à 150 Hz avec des accéléromètres de laboratoire). La conversion en g (9,806 65 m/s²) permet la comparaison avec leurs tableaux."));

  const ok = (r) => r && !r.erreur;
  const sel = document.createElement("select");
  for (const [v, l] of [["somme", "somme des trois axes (indépendante de l'orientation)"], ["vertical", "axe vertical déclaré seulement"]]) {
    const o = document.createElement("option"); o.value = v; o.textContent = l; sel.appendChild(o);
  }
  sel.value = patModeAxes;
  sel.addEventListener("change", () => { patModeAxes = sel.value; activerOnglet("patient"); });
  const lab = patLabel("Spectres et transmissibilité : ", sel);
  lab.className = "pat-mode-axes no-print";
  sec.appendChild(lab);

  const base = baseNomFichier();
  const series = [];
  const dsp = (r) => {
    if (patModeAxes === "vertical") return { freqs: r.welch[r.axeVert].freqs, psd: r.welch[r.axeVert].psd };
    const s = new Float64Array(r.welch[0].psd.length);
    for (const w of r.welch) for (let k = 0; k < s.length; k++) s[k] += w.psd[k];
    return { freqs: r.welch[0].freqs, psd: s };
  };
  let fMaxAff = 80;
  for (const [r, nom, coul] of [[res.plancher, "plancher", "#c98a3b"], [res.support, "support", "#0f4c5c"]]) {
    if (!ok(r)) continue;
    const { freqs, psd } = dsp(r);
    const xs = [], ys = [];
    for (let k = 0; k < freqs.length; k++) if (freqs[k] >= 1 && freqs[k] <= r.fHaut) { xs.push(freqs[k]); ys.push(10 * Math.log10(Math.max(psd[k], 1e-20))); }
    series.push({ xs, ys, couleur: coul, label: nom });
    fMaxAff = Math.min(fMaxAff, r.fHaut);
  }
  if (series.length) {
    sec.appendChild(creerBlocGraphique("pat-dsp", "Densité spectrale de puissance", (canvas) => {
      tracerCourbe(canvas, series, { titre: `Densité spectrale de puissance de l'accélération (${patModeAxes === "vertical" ? "axe vertical" : "somme des 3 axes"}), Welch, fenêtres de Hann`,
        xlabel: "fréquence (Hz)", ylabel: "DSP (dB réf. 1 (m/s²)²/Hz)", logX: true, xMin: 1, xMax: fMaxAff, formatX: formatHz });
    }, () => `${base}_patient_dsp-acceleration.png`));
  }

  const tr = res.transmission;
  if (tr && tr.erreur) sec.appendChild(patElement("div", "avertissement", tr.erreur));
  else if (tr) {
    const src = patModeAxes === "vertical" ? tr.vertical : tr.somme;
    const xs = [], ys = [];
    let pic = -Infinity, fPic = NaN;
    for (let k = 0; k < tr.freqs.length; k++) {
      const f = tr.freqs[k];
      if (f < 1 || f > tr.fHaut) continue;
      const t = 10 * Math.log10(Math.max(src.sup[k], 1e-20) / Math.max(src.pla[k], 1e-20));
      xs.push(f); ys.push(t);
      if (t > pic) { pic = t; fPic = f; }
    }
    sec.appendChild(creerBlocGraphique("pat-transmissibilite", "Transmissibilité plancher vers support", (canvas) => {
      tracerCourbe(canvas, [{ xs, ys, couleur: "#7a3b8a" }],
        { titre: "Transmissibilité T = DSP support / DSP plancher (au-dessus de 0 dB : le support amplifie)", xlabel: "fréquence (Hz)", ylabel: "T (dB)", logX: true, xMin: 1, xMax: tr.fHaut, formatX: formatHz,
          lignesH: [{ y: 0, couleur: "#20242b" }] });
    }, () => `${base}_patient_transmissibilite.png`));
    sec.appendChild(patElement("p", "note",
      `Transmissibilité maximale : ${patFormat(pic, 1)} dB à ${patFormat(fPic, 1)} Hz (rapport de puissances ${patFormat(Math.pow(10, pic/10), 2)}, rapport d'amplitudes ${patFormat(Math.pow(10, pic/20), 2)}). ` +
      `Calcul sur ${patMinSec(tr.tB - tr.tA)} communs aux deux téléphones, rééchantillonnés à ${patFormat(tr.fs, 0)} Hz, ${tr.nSeg} segments de Welch, résolution ${patFormat(tr.df, 2)} Hz. ` +
      "Définition de Gibb et al. (2025) : rapport des densités spectrales de puissance, plancher en entrée. Les téléphones ne sont synchronisés qu'à environ une seconde près : seuls des spectres moyennés sont comparés, sans phase ni cohérence. " +
      "Le rééchantillonnage sur une grille régulière (interpolation linéaire) atténue légèrement le haut de bande : environ 1 dB à 20 % de la fréquence d'échantillonnage, moins de 0,1 dB à 5 %."));
  }
  for (const r of [res.support, res.plancher]) {
    if (ok(r) && r.trous) sec.appendChild(patElement("p", "note", `${r.nomFichier} : ${r.trous} interruption(s) d'enregistrement détectée(s) ; les valeurs y sont interpolées linéairement.`));
  }
  return sec;
}

/* ---------------------------------------------------------------- confort */
function patSectionConfort(res) {
  const sec = patElement("div", "pat-section");
  sec.appendChild(patElement("h3", null, "3. Confort vibratoire et chocs (indicatif, ISO 2631-1)"));
  const ok = (r) => r && !r.erreur;
  const tels = [["support", res.support], ["plancher", res.plancher]].filter(([, r]) => ok(r));
  if (!tels.length) { sec.appendChild(patElement("p", "note", "Nécessite au moins un téléphone.")); return sec; }

  sec.appendChild(patElement("p", "note",
    "ISO 2631-1 est établie sur des adultes : pour un nouveau-né ou un enfant, ces valeurs comparent des phases, des véhicules ou des supports, elles ne fixent pas de seuil de risque. " +
    "Pondérations appliquées : Wk sur l'axe vertical déclaré, Wd sur les deux autres, facteurs k = 1. Gibb et al. (2025) n'appliquent aucune pondération, faute de pondérations prévues pour un patient couché : les valeurs non pondérées sont dans la partie 2."));

  const lignes = tels.map(([nom, r]) => {
    const v = r.axeVert;
    const ratioMtvv = r.mtvv[v] / r.aw[v];
    const ratioVdv = r.vdv[v] / (r.aw[v] * Math.pow(r.duree, 0.25));
    const cls = PAT_CLASSES_CONFORT[patClasseConfort(r.av)];
    return `<tr><td>${nom}</td>` +
      PAT_NOMS_AXES.map((_, a) => `<td>${patFormat(r.aw[a], 3)}</td>`).join("") +
      `<td>${patFormat(r.av, 3)}<br><span class="note">${cls.nom}</span></td>` +
      `<td>${patFormat(r.vdvTotal, 2)}</td><td>${patFormat(r.crete[v], 1)}</td>` +
      `<td>${patFormat(ratioMtvv, 2)}${ratioMtvv > 1.5 ? " ⚠" : ""}</td><td>${patFormat(ratioVdv, 2)}${ratioVdv > 1.75 ? " ⚠" : ""}</td></tr>`;
  });
  const t = document.createElement("table");
  t.className = "pat-table";
  t.innerHTML = `<thead><tr><th>Position</th><th>a<sub>w</sub> x (m/s²)</th><th>a<sub>w</sub> y (m/s²)</th><th>a<sub>w</sub> z (m/s²)</th><th>Valeur totale a<sub>v</sub> (m/s²)</th><th>VDV (m/s<sup>1,75</sup>)</th><th>Facteur de crête (vertical)</th><th>MTVV / a<sub>w</sub> (vertical)</th><th>VDV / (a<sub>w</sub>·T<sup>1/4</sup>) (vertical)</th></tr></thead><tbody>${lignes.join("")}</tbody>`;
  sec.appendChild(t);
  sec.appendChild(patElement("p", "note",
    "⚠ : critère d'ISO 2631-1 (6.3.3) indiquant que la valeur efficace sous-estime les chocs (MTVV / aw > 1,5 ou VDV / (aw·T^1/4) > 1,75) : la VDV et la MTVV sont alors les indicateurs à retenir. " +
    "Valeur totale sur la période rangée sur l'échelle de confort de l'annexe C (plages qui se chevauchent : classe la moins sévère retenue)."));

  const base = baseNomFichier();
  const series = tels.map(([nom, r]) => ({ xs: r.minutes.xs, ys: r.minutes.av, couleur: nom === "support" ? "#0f4c5c" : "#c98a3b", label: nom }));
  if (series.some(s => s.xs.length)) {
    sec.appendChild(creerBlocGraphique("pat-confort", "Valeur totale pondérée par minute", (canvas) => {
      tracerCourbe(canvas, series, {
        titre: "Valeur totale pondérée par minute (limites de l'échelle de confort ISO 2631-1 tracées si elles sont atteintes)",
        xlabel: "temps (min)", ylabel: "a_v (m/s²)", decimalesYAuto: true, yMin: 0, etendueMinY: 0.05,
        yMax: Math.max(...series.flatMap(s => s.ys.filter(isFinite)), 0.05) * 1.15,
        lignesH: PAT_CLASSES_CONFORT.slice(0, -1).map((c, i) => ({ y: c.max, couleur: PAT_CLASSES_CONFORT[i+1].couleur, label: PAT_CLASSES_CONFORT[i+1].nom })),
      });
    }, () => `${base}_patient_confort-minute.png`));

    const sup = res.support && !res.support.erreur ? res.support : res.plancher;
    const tempsClasse = PAT_CLASSES_CONFORT.map(() => 0);
    sup.minutes.av.forEach((a, k) => { tempsClasse[patClasseConfort(a)] += sup.minutes.durees[k]; });
    const total = tempsClasse.reduce((a, b) => a + b, 0);
    const tc = document.createElement("table");
    tc.className = "pat-table pat-table-classes";
    tc.innerHTML = `<thead><tr><th>Classe (ISO 2631-1, annexe C)</th><th>Plage (m/s²)</th><th>Temps (${sup === res.support ? "support" : "plancher"}, minutes complètes)</th><th>Part</th></tr></thead><tbody>` +
      PAT_CLASSES_CONFORT.map((c, i) => `<tr><td><span class="pastille" style="background:${c.couleur}"></span>${c.nom}</td><td>${c.plage}</td><td>${patMinSec(tempsClasse[i])}</td><td>${patFormat(total ? 100 * tempsClasse[i] / total : NaN, 0)} %</td></tr>`).join("") +
      "</tbody>";
    sec.appendChild(tc);
  }

  // Chocs : sur l'acceleration ponderee verticale du support (ou du plancher a defaut)
  const r = res.support && !res.support.erreur ? res.support : res.plancher;
  const rmsV = r.aw[r.axeVert];
  const seuil = patFacteurChoc * rmsV;
  const evts = patDetecterChocs(r.vertical, r.fs, r.tA, seuil);
  const blocChocs = patElement("div", "pat-chocs");
  blocChocs.appendChild(patElement("h4", null, `Chocs sur l'axe vertical (${r === res.support ? "support" : "plancher"})`));
  const inFacteur = document.createElement("input");
  inFacteur.type = "number"; inFacteur.step = "0.5"; inFacteur.min = "1"; inFacteur.value = String(patFacteurChoc);
  inFacteur.addEventListener("change", () => { const v = parseFloat(inFacteur.value); if (isFinite(v) && v > 0) { patFacteurChoc = v; activerOnglet("patient"); } });
  const labF = patLabel("Seuil = ", inFacteur);
  labF.appendChild(document.createTextNode(` × la valeur efficace pondérée verticale (${patFormat(rmsV, 3)} m/s²), soit ${patFormat(seuil, 2)} m/s²`));
  labF.className = "pat-seuil no-print";
  blocChocs.appendChild(labF);
  const tri = [...evts].sort((a, b) => b.pic - a.pic).slice(0, 10);
  blocChocs.appendChild(patElement("p", null, `${evts.length} événement${evts.length > 1 ? "s" : ""} au-dessus de ${patFormat(seuil, 2)} m/s² (crête pondérée), regroupés lorsqu'ils sont séparés de moins de 1 s.`));
  if (tri.length) {
    const te = document.createElement("table");
    te.className = "pat-table";
    te.innerHTML = `<thead><tr><th>Rang</th><th>Instant (temps du WAV)</th><th>Crête pondérée (m/s²)</th></tr></thead><tbody>` +
      tri.map((e, k) => `<tr><td>${k+1}</td><td>${patMinSec(e.t)}</td><td>${patFormat(e.pic, 2)}</td></tr>`).join("") + "</tbody>";
    blocChocs.appendChild(te);
  }
  blocChocs.appendChild(patElement("p", "note", "Le seuil est un choix d'analyse, pas une valeur normative. Les instants permettent de retrouver l'événement (ralentisseur, poser, turbulence) dans l'onglet Trajet."));
  sec.appendChild(blocChocs);
  return sec;
}
