"use strict";
/* =========================================================================
   DSP.JS — lecture WAV/calibration, filtres de ponderation, FFT, PSD (Welch
   et STFT glissante), niveaux acoustiques, tiers d'octave.

   Ce module reprend telles quelles les fonctions de calcul de la version
   precedente de l'outil (validees a 0,1 dB pres contre une implementation
   Python/scipy independante sur des signaux de synthese). Les seules
   nouveautes sont la parametrisation de la fenetre d'analyse (calculerPsd,
   auparavant "welch" a parametres fixes) et la fonction calculerStft, qui
   reutilise exactement la meme formule par trame pour produire le
   spectrogramme.
   ========================================================================= */

/* =========================================================================
   COEFFICIENTS DE PONDERATION A ET C, IEC 61672, PRECALCULES POUR 44100 Hz
   (transformee bilineaire du prototype analogique standard, verifiee :
   gain de 0 dB a 1000 Hz pour les deux, -19.1 dB pour A a 100 Hz)
   ========================================================================= */
const FS_ATTENDU = 44100;
const B_A = [2.5574112520e-01, -5.1148225041e-01, -2.5574112520e-01, 1.0229645008e+00, -2.5574112520e-01, -5.1148225041e-01, 2.5574112520e-01];
const A_A = [1.0000000000e+00, -4.0195761811e+00, 6.1894064429e+00, -4.4531989035e+00, 1.4208429496e+00, -1.4182547383e-01, 4.3511772335e-03];
const B_C = [2.1700856195e-01, 1.7647146405e-17, -4.3401712390e-01, -1.7647146405e-17, 2.1700856195e-01];
const A_C = [1.0000000000e+00, -2.1346749637e+00, 1.2793335332e+00, -1.4955984609e-01, 4.9087001746e-03];
const PREF = 20e-6;

/* Passe-haut Butterworth ordre 2, frequence de coupure 20 Hz, precalcule
   pour 44100 Hz (memes methode et validation que B_A/A_C ci-dessus :
   transformee bilineaire, formules RBJ audio-eq-cookbook, Q = 1/sqrt(2)
   pour Butterworth ; verifie : -3.01 dB a 20 Hz, -12.30 dB a 10 Hz, 0 dB
   a 1000 Hz). Applique au signal de pression brut, avant les ponderations
   A/C et avant l'OASPL non pondere, pour tous les niveaux integres
   (OASPL, LAeq, LCeq, LCpeak, LAFmax) uniquement : le spectre en bande
   fine, les tiers d'octave et le spectrogramme restent sur le signal non
   filtre. */
const B_HP20 = [9.9798711568e-01, -1.9959742314e+00, 9.9798711568e-01];
const A_HP20 = [1.0000000000e+00, -1.9959701796e+00, 9.9597828306e-01];

const FREQ_TIERS_OCTAVE = [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];

/* Tailles de fenetre proposees a l'utilisateur pour l'analyse FFT (spectre,
   tiers d'octave, spectrogramme). Puissances de 2 uniquement (radix-2). */
const TAILLES_FFT_DISPONIBLES = [256,512,1024,2048,4096,8192,16384,32768,65536];

/* Reponse en frequence TYPIQUE du MP23ABS1 (courbe fabricant, pas une
   mesure individuelle), en dB d'ecart par rapport a une reponse plate.
   Utilisee pour corriger le spectre en bande fine et les tiers d'octave
   uniquement (pas les niveaux globaux LAeq/LCpeak). */
const COURBE_MICRO_HZ = [20,30,50,70,100,200,500,1000,1500,2000,3000,4000,5000,6000,7000,8000,9000,10000,11000,12000,13000,14000,15000,16000,17000,18000,19000,20000];
const COURBE_MICRO_DB = [-2.3,-1.3,-0.7,-0.4,-0.2,-0.1,0.0,-0.3,0.0,0.0,0.1,0.2,0.3,0.4,0.6,0.8,1.2,1.7,2.0,2.3,2.6,3.0,3.5,4.5,6.0,7.5,9.0,10.0];

// Precalcule une seule fois (evite de reallouer/reconstruire ce tableau a
// chaque appel : correctionMicroDb() est appelee jusqu'a plusieurs dizaines
// de millions de fois lors du tracé du spectrogramme d'un fichier long).
const LOG_COURBE_MICRO_HZ = COURBE_MICRO_HZ.map(v=>Math.log10(v));

function correctionMicroDb(f) {
  const fc = Math.min(Math.max(f, COURBE_MICRO_HZ[0]), COURBE_MICRO_HZ[COURBE_MICRO_HZ.length-1]);
  const lf = Math.log10(Math.max(fc,1e-6));
  let i = 0; while (i < LOG_COURBE_MICRO_HZ.length-2 && lf > LOG_COURBE_MICRO_HZ[i+1]) i++;
  const t = (lf - LOG_COURBE_MICRO_HZ[i]) / (LOG_COURBE_MICRO_HZ[i+1]-LOG_COURBE_MICRO_HZ[i] || 1);
  return COURBE_MICRO_DB[i] + t*(COURBE_MICRO_DB[i+1]-COURBE_MICRO_DB[i]);
}

/* ============================================================ filtre IIR */
function lfilter(b, a, x) {
  const y = new Float64Array(x.length);
  const nb = b.length, na = a.length;
  for (let n = 0; n < x.length; n++) {
    let acc = 0;
    for (let k = 0; k < nb; k++) if (n - k >= 0) acc += b[k] * x[n - k];
    for (let k = 1; k < na; k++) if (n - k >= 0) acc -= a[k] * y[n - k];
    y[n] = acc / a[0];
  }
  return y;
}

/* Calcule lfilter uniquement sur la plage [debut, fin) de la sortie deja
   allouee `y`, en reprenant l'historique du filtre a partir des echantillons
   deja ecrits avant `debut` (x et y doivent contenir intacts les
   echantillons precedents : la recursion ne regarde que n-k >= 0). Permet de
   decouper un filtrage long (mesure de session : ~33 s a elles trois, sur
   les 4 voies, pour un fichier de 25 min — le poste de calcul le plus couteux
   de l'analyse, plus que le spectre ou le spectrogramme) en tranches
   entrecoupees de pauses, avec un resultat strictement identique a un appel
   unique de lfilter sur tout le signal. lfilter elle-meme reste inchangee
   (utilisee telle quelle ailleurs, y compris dans les tests). */
function lfilterTranche(b, a, x, y, debut, fin) {
  const nb = b.length, na = a.length;
  for (let n = debut; n < fin; n++) {
    let acc = 0;
    for (let k = 0; k < nb; k++) if (n - k >= 0) acc += b[k] * x[n - k];
    for (let k = 1; k < na; k++) if (n - k >= 0) acc -= a[k] * y[n - k];
    y[n] = acc / a[0];
  }
}

/* Variante chunkee (asynchrone) de lfilter, pour laisser la main au
   navigateur pendant un filtrage long. onProgres(fraction) est appelee apres
   chaque tranche ; ceder() doit renvoyer une promesse qui laisse le
   navigateur repeindre avant de continuer. Pour un signal plus court qu'une
   tranche (tous les fichiers de test existants, quelques secondes), la
   boucle ne fait qu'un seul tour : aucune pause ajoutee, aussi rapide
   qu'avant. */
const TAILLE_TRANCHE_LFILTER = 500000; // echantillons (~11 ms de calcul a 44100 Hz par tranche)
async function lfilterAsync(b, a, x, onProgres, ceder) {
  const y = new Float64Array(x.length);
  for (let debut = 0; debut < x.length; debut += TAILLE_TRANCHE_LFILTER) {
    const fin = Math.min(debut + TAILLE_TRANCHE_LFILTER, x.length);
    lfilterTranche(b, a, x, y, debut, fin);
    if (onProgres) onProgres(fin / x.length);
    if (fin < x.length && ceder) await ceder();
  }
  return y;
}

/* ================================================================== FFT */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      const half = len / 2;
      for (let j = 0; j < half; j++) {
        const ur = re[i+j], ui = im[i+j];
        const vr = re[i+j+half]*curWr - im[i+j+half]*curWi;
        const vi = re[i+j+half]*curWi + im[i+j+half]*curWr;
        re[i+j] = ur+vr; im[i+j] = ui+vi;
        re[i+j+half] = ur-vr; im[i+j+half] = ui-vi;
        const nWr = curWr*wr0 - curWi*wi0, nWi = curWr*wi0 + curWi*wr0;
        curWr = nWr; curWi = nWi;
      }
    }
  }
}

function pow2Below(n) { let p = 1; while (p * 2 <= n) p *= 2; return p; }

/* ================================================================ fenetres */
function genererFenetre(type, n) {
  const w = new Float64Array(n);
  let winPower = 0;
  for (let i = 0; i < n; i++) {
    let v;
    if (type === "hamming") v = 0.54 - 0.46*Math.cos(2*Math.PI*i/(n-1));
    else if (type === "rect") v = 1.0;
    else v = 0.5 - 0.5*Math.cos(2*Math.PI*i/(n-1)); // hann par defaut
    w[i] = v;
    winPower += v*v;
  }
  return { w, winPower };
}

function parametresFftParDefaut(fs, longueurSignal) {
  return {
    nperseg: Math.min(pow2Below(fs), pow2Below(longueurSignal)),
    recouvrement: 50,   // pourcentage
    fenetre: "hann",
  };
}

/* STFT glissante pour le spectrogramme : meme formule par trame que
   calculerPsd (un segment de Welch, sans moyenne sur l'axe temps), afin que
   le niveau colore du spectrogramme soit coherent avec le spectre en
   bande fine trace a cote. */
const STFT_MAX_TRAMES = 3000;

/* Choisit nperseg et le pas (hop) entre segments consecutifs. Une petite
   fenetre combinee a un fort recouvrement sur un enregistrement long (25 min,
   4 voies) produirait des dizaines de milliers de segments, chacun coutant
   une FFT complete : sur un fichier de mesure de terrain, c'est le poste de
   calcul dominant (mesure de session : calculerPsd + calculerStft comptaient
   a elles deux pour pres de la moitie du temps total d'analyse sur 25 min/4
   voies). Au-dela de STFT_MAX_TRAMES segments, le pas est directement
   agrandi pour VISER ce nombre de segments CALCULES (pas seulement
   affiches) : moins de FFT a calculer pour un resultat affiche equivalent,
   plutot que de calculer tous les segments dans le pas dense puis de les
   regrouper par moyenne apres coup (ancien comportement, qui ne reduisait
   que la memoire/l'affichage, pas le calcul). Le pas reste toujours borne a
   nperseg : deux fenetres consecutives restent au moins jointives, aucune
   portion du signal ne se retrouve hors de toute fenetre d'analyse (un
   evenement bref ne peut pas disparaitre entre deux segments). */
function parametresSegmentationFft(longueurSignal, params) {
  const nperseg = Math.min(params.nperseg, pow2Below(longueurSignal));
  const recouvrement = Math.min(Math.max(params.recouvrement, 0), 90);
  const stepSouhaite = Math.max(1, Math.round(nperseg * (1 - recouvrement/100)));
  const nSegSouhaite = Math.max(0, Math.floor((longueurSignal - nperseg) / stepSouhaite) + 1);
  let step = stepSouhaite;
  if (nSegSouhaite > STFT_MAX_TRAMES) {
    step = Math.min(nperseg, Math.ceil(stepSouhaite * nSegSouhaite / STFT_MAX_TRAMES));
  }
  return { nperseg, step };
}

/* ---------------------------------------------------------------------
   Calcul partage entre calculerPsd et calculerStft : les deux utilisent
   exactement la meme boucle par segment (fenetrage + FFT + module carre),
   sur le meme signal et les memes parametres — seule differe la maniere
   dont le resultat par segment est ensuite consomme (moyenne pour l'un,
   trame par trame pour l'autre). Les calculer separement (comme avant) fait
   tourner cette boucle deux fois pour rien. Le resultat de la boucle est mis
   en cache par signal (WeakMap, nettoye automatiquement quand le signal
   n'est plus reference, par exemple lors d'une nouvelle analyse) et par jeu
   de parametres FFT : appeler calculerPsd PUIS calculerStft sur le meme
   signal ne fait tourner la FFT qu'une seule fois, sans que la signature ni
   le comportement externe de calculerPsd/calculerStft ne changent (utilisees
   telles quelles ailleurs, y compris directement dans les tests).
   ========================================================================= */
const _cacheSegmentsFft = new WeakMap(); // signal (Float32Array) -> Map(cle -> resultat)
function _cleSegmentsFft(fs, params) { return `${fs}|${params.nperseg}|${params.recouvrement}|${params.fenetre}`; }

function _obtenirCacheSegments(signal) {
  let m = _cacheSegmentsFft.get(signal);
  if (!m) { m = new Map(); _cacheSegmentsFft.set(signal, m); }
  return m;
}

function _preparerSegmentation(signal, fs, params) {
  const { nperseg, step } = parametresSegmentationFft(signal.length, params);
  const { w: fen, winPower } = genererFenetre(params.fenetre, nperseg);
  const nBins = nperseg / 2 + 1;
  const scale = 1.0 / (fs * winPower);
  const freqs = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) freqs[k] = k * fs / nperseg;
  const nSegments = Math.max(0, Math.floor((signal.length - nperseg) / step) + 1);
  return { nperseg, step, fen, nBins, scale, freqs, nSegments };
}

/* Traite les segments d'indice [iDebut, iFin) : accumule dans psdSum (pour
   calculerPsd) et pousse une trame par segment dans trames/temps (pour
   calculerStft). Un seul passage alimente les deux a la fois. */
function _traiterSegmentsFft(signal, fs, prep, iDebut, iFin, psdSum, trames, temps, re, im) {
  const { nperseg, step, fen, nBins, scale } = prep;
  for (let i = iDebut; i < iFin; i++) {
    const start = i * step;
    for (let k = 0; k < nperseg; k++) re[k] = signal[start+k] * fen[k];
    im.fill(0);
    fft(re, im);
    const col = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) {
      let p = (re[k]*re[k] + im[k]*im[k]) * scale;
      if (k > 0 && k < nBins - 1) p *= 2;   // energie des frequences negatives repliee
      col[k] = p;
      psdSum[k] += p;
    }
    trames.push(col);
    temps.push((start + nperseg/2) / fs);
  }
}

function _finaliserSegmentsFft(nBins, freqs, nperseg, fs, psdSum, trames, temps, nSegments) {
  const nSeg = nSegments || 1;
  // Stocke le PSD en simple precision : les niveaux en dB n'ont pas besoin
  // de la precision de Float64, et un fichier long avec de nombreuses
  // combinaisons de parametres FFT explorees (mises en cache par voie dans
  // app.js) reste ainsi sous une empreinte memoire raisonnable.
  const psd = new Float32Array(nBins);
  for (let k = 0; k < nBins; k++) psd[k] = psdSum[k] / nSeg;

  // Garde-fou : si l'arrondi du pas (parametresSegmentationFft) laissait
  // malgre tout un peu plus de segments que STFT_MAX_TRAMES, on regroupe les
  // derniers par moyenne (meme principe que l'ancien comportement, mais ne
  // se declenche plus qu'en cas d'arrondi, pas comme mecanisme principal).
  let tramesFinales = trames, tempsFinal = temps, tramesGroupees = 0;
  if (trames.length > STFT_MAX_TRAMES) {
    const groupe = Math.ceil(trames.length / STFT_MAX_TRAMES);
    tramesFinales = []; tempsFinal = [];
    for (let i = 0; i < trames.length; i += groupe) {
      const fin = Math.min(i + groupe, trames.length);
      const col = new Float32Array(nBins);
      let tSomme = 0;
      for (let j = i; j < fin; j++) { for (let k = 0; k < nBins; k++) col[k] += trames[j][k]; tSomme += temps[j]; }
      const n = fin - i;
      for (let k = 0; k < nBins; k++) col[k] /= n;
      tramesFinales.push(col); tempsFinal.push(tSomme / n);
    }
    tramesGroupees = groupe;
  }

  return { freqs, nperseg, df: fs / nperseg, psd, temps: tempsFinal, trames: tramesFinales, tramesGroupees };
}

function _calculerSegmentsFft(signal, fs, params) {
  const cache = _obtenirCacheSegments(signal);
  const cle = _cleSegmentsFft(fs, params);
  if (cache.has(cle)) return cache.get(cle);

  const prep = _preparerSegmentation(signal, fs, params);
  const { nperseg, nBins, freqs, nSegments } = prep;
  const psdSum = new Float64Array(nBins);
  const trames = [], temps = [];
  const re = new Float64Array(nperseg), im = new Float64Array(nperseg);
  _traiterSegmentsFft(signal, fs, prep, 0, nSegments, psdSum, trames, temps, re, im);

  const resultat = _finaliserSegmentsFft(nBins, freqs, nperseg, fs, psdSum, trames, temps, nSegments);
  cache.set(cle, resultat);
  return resultat;
}

/* Variante chunkee (asynchrone) de _calculerSegmentsFft, utilisee par
   l'analyse interactive (app.js) pour laisser la main au navigateur entre
   deux tranches de segments plutot que de bloquer d'un bloc — meme resultat,
   mis dans le meme cache (un appel synchrone ulterieur via calculerPsd ou
   calculerStft retrouve alors le resultat deja calcule, sans le recalculer). */
const TRANCHE_SEGMENTS_FFT = 64; // nombre de segments calcules entre deux pauses
async function calculerSegmentsFftAsync(signal, fs, params, onProgres, ceder) {
  const cache = _obtenirCacheSegments(signal);
  const cle = _cleSegmentsFft(fs, params);
  if (cache.has(cle)) { if (onProgres) onProgres(1); return cache.get(cle); }

  const prep = _preparerSegmentation(signal, fs, params);
  const { nperseg, nBins, freqs, nSegments } = prep;
  const psdSum = new Float64Array(nBins);
  const trames = [], temps = [];
  const re = new Float64Array(nperseg), im = new Float64Array(nperseg);

  for (let i = 0; i < nSegments; i += TRANCHE_SEGMENTS_FFT) {
    const fin = Math.min(i + TRANCHE_SEGMENTS_FFT, nSegments);
    _traiterSegmentsFft(signal, fs, prep, i, fin, psdSum, trames, temps, re, im);
    if (onProgres) onProgres(nSegments > 0 ? fin / nSegments : 1);
    if (fin < nSegments && ceder) await ceder();
  }

  const resultat = _finaliserSegmentsFft(nBins, freqs, nperseg, fs, psdSum, trames, temps, nSegments);
  cache.set(cle, resultat);
  return resultat;
}

/* Periodogramme de Welch, fenetre/recouvrement/type parametrables. Delegue
   au calcul partage ci-dessus (_calculerSegmentsFft) : signature et resultat
   inchanges pour les appelants existants. */
function calculerPsd(signal, fs, params) {
  const r = _calculerSegmentsFft(signal, fs, params);
  return { freqs: r.freqs, psd: r.psd, df: r.df, nperseg: r.nperseg };
}

function calculerStft(signal, fs, params) {
  const r = _calculerSegmentsFft(signal, fs, params);
  return { freqs: r.freqs, temps: r.temps, trames: r.trames, nperseg: r.nperseg, df: r.df, tramesGroupees: r.tramesGroupees };
}

/* ==================================================== reponse ponderee, dB, pour l'integration en bande */
function reponsePonderationDb(f, type) {
  const ff = Math.max(f, 1e-6);
  function rA(fr) {
    return (12200**2 * fr**4) / ((fr**2+20.6**2)*(fr**2+12200**2)*Math.sqrt(fr**2+107.7**2)*Math.sqrt(fr**2+737.9**2));
  }
  function rC(fr) {
    return (12200**2 * fr**2) / ((fr**2+20.6**2)*(fr**2+12200**2));
  }
  if (type === "A") return 20*Math.log10(rA(ff)/rA(1000));
  return 20*Math.log10(rC(ff)/rC(1000));
}

/* ============================================================ niveaux */
function niveauDb(rms, pref) { return rms > 0 ? 20*Math.log10(rms/pref) : -Infinity; }

function leq(signal, pref) {
  let s = 0;
  for (let i = 0; i < signal.length; i++) s += signal[i]*signal[i];
  return niveauDb(Math.sqrt(s/signal.length), pref);
}

function niveauTemporel(signal, fs, pref, fenetreS) {
  const taille = Math.max(1, Math.round(fenetreS*fs));
  const n = Math.floor(signal.length/taille);
  const temps = [], niveaux = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < taille; k++) { const v = signal[i*taille+k]; s += v*v; }
    niveaux.push(niveauDb(Math.sqrt(s/taille), pref));
    temps.push((i+0.5)*fenetreS);
  }
  return { temps, niveaux };
}

function lmaxFast(signalA, fs, pref, tau=0.125) {
  const alpha = 1 - Math.exp(-1/(tau*fs));
  let acc = 0, pic = 0;
  for (let i = 0; i < signalA.length; i++) {
    const pInst = signalA[i]*signalA[i];
    acc += alpha*(pInst-acc);
    if (acc > pic) pic = acc;
  }
  return niveauDb(Math.sqrt(pic), pref);
}

function lpeak(signalC, pref) {
  let m = 0;
  for (let i = 0; i < signalC.length; i++) { const a = Math.abs(signalC[i]); if (a > m) m = a; }
  return niveauDb(m, pref);
}

function tiersOctave(freqs, psd, df, ponderation, pref) {
  if (pref === undefined) pref = PREF;
  const niveaux = [];
  for (const fc of FREQ_TIERS_OCTAVE) {
    const fBas = fc/Math.pow(2,1/6), fHaut = fc*Math.pow(2,1/6);
    let puissance = 0;
    for (let k = 0; k < freqs.length; k++) {
      if (freqs[k] >= fBas && freqs[k] < fHaut) {
        let p = psd[k];
        if (ponderation) p *= Math.pow(10, reponsePonderationDb(freqs[k], ponderation)/10);
        puissance += p*df;
      }
    }
    niveaux.push(niveauDb(Math.sqrt(Math.max(puissance,0)), pref));
  }
  return niveaux;
}

/* ======================================================== lecture WAV */
function lireWav(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0,false) !== 0x52494646) throw new Error("Fichier non reconnu comme WAV (en-tete RIFF absent).");
  let pos = 12, fmt = null, dataOffset = -1, dataLength = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos),dv.getUint8(pos+1),dv.getUint8(pos+2),dv.getUint8(pos+3));
    const size = dv.getUint32(pos+4, true);
    if (id === "fmt ") {
      fmt = {
        audioFormat: dv.getUint16(pos+8, true),
        numChannels: dv.getUint16(pos+10, true),
        sampleRate: dv.getUint32(pos+12, true),
        bitsPerSample: dv.getUint16(pos+22, true),
      };
    } else if (id === "data") {
      dataOffset = pos + 8; dataLength = size;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) throw new Error("Structure WAV incomplete (fmt ou data manquant).");
  if (fmt.bitsPerSample !== 16) throw new Error("Seuls les fichiers 16 bits sont pris en charge par cet outil.");

  const nCh = fmt.numChannels;
  const nSamples = Math.floor(dataLength / 2 / nCh);
  // Float32 (et non Float64) : precision largement suffisante pour une
  // source 16 bits, et empreinte memoire divisee par deux sur un fichier
  // de plusieurs minutes (canaux, puis le signal calibre qui en derive).
  const canaux = [];
  for (let c = 0; c < nCh; c++) canaux.push(new Float32Array(nSamples));
  let p = dataOffset;
  for (let i = 0; i < nSamples; i++) {
    for (let c = 0; c < nCh; c++) {
      canaux[c][i] = dv.getInt16(p, true) / 32768.0;
      p += 2;
    }
  }
  return { fs: fmt.sampleRate, nCh, canaux, dureeS: nSamples/fmt.sampleRate };
}

/* ================================================= lecture calibration */
function lireCalibration(texte) {
  const cal = {0:null,1:null,2:null,3:null};
  if (!texte) return cal;
  const re = /voie (\d+), SPL_pleine_echelle \(dB\) = (\S+)/g;
  let m;
  while ((m = re.exec(texte)) !== null) {
    const v = parseInt(m[1]), val = m[2];
    if (val.toUpperCase() !== "A_COMPLETER") cal[v] = parseFloat(val);
  }
  return cal;
}
