// Generation de fichiers .WAV (16 bits, N voies) et .TXT de calibration
// synthetiques, pour les tests Playwright. Signaux de reference a niveau
// connu (ton pur, bruit blanc gaussien) : cf. tests/niveaux.spec.js.
const fs = require("fs");

function construireWav(sampleRate, canaux) {
  const nCh = canaux.length;
  const nSamples = canaux[0].length;
  const dataSize = nSamples * nCh * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);           // taille du sous-bloc fmt
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(nCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * nCh * 2, 28); // byte rate
  buf.writeUInt16LE(nCh * 2, 32);       // block align
  buf.writeUInt16LE(16, 34);           // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  let p = 44;
  for (let i = 0; i < nSamples; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, canaux[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), p);
      p += 2;
    }
  }
  return buf;
}

// Amplitude crete d'un ton pur pour obtenir un niveau RMS donne (en dBFS,
// c'est-a-dire relatif a une amplitude crete 1.0 = 0 dB de reference RMS
// utilise par l'outil quand aucune calibration n'est appliquee).
function amplitudePourNiveauDbfs(niveauDbfsRms) {
  const rms = Math.pow(10, niveauDbfsRms / 20);
  return rms * Math.SQRT2;
}

function genererTonPur({ freqHz, niveauDbfsRms, dureeS, fs: fe = 44100, nCh = 4 }) {
  const n = Math.round(dureeS * fe);
  const amplitude = amplitudePourNiveauDbfs(niveauDbfsRms);
  const canal = new Float64Array(n);
  for (let i = 0; i < n; i++) canal[i] = amplitude * Math.sin(2 * Math.PI * freqHz * i / fe);
  const canaux = [];
  for (let c = 0; c < nCh; c++) canaux.push(canal);
  return { fs: fe, canaux };
}

// Bruit blanc gaussien (Box-Muller), RMS = sigma exactement en esperance.
function genererBruitBlanc({ niveauDbfsRms, dureeS, fs: fe = 44100, nCh = 4, graine = 1234 }) {
  const n = Math.round(dureeS * fe);
  const sigma = Math.pow(10, niveauDbfsRms / 20);
  let etat = graine;
  function alea() { // generateur pseudo-aleatoire deterministe (reproductible entre executions)
    etat = (etat * 1664525 + 1013904223) >>> 0;
    return etat / 4294967296;
  }
  const canaux = [];
  for (let c = 0; c < nCh; c++) {
    const canal = new Float64Array(n);
    for (let i = 0; i < n; i += 2) {
      const u1 = Math.max(alea(), 1e-12), u2 = alea();
      const r = Math.sqrt(-2 * Math.log(u1));
      canal[i] = sigma * r * Math.cos(2 * Math.PI * u2);
      if (i + 1 < n) canal[i+1] = sigma * r * Math.sin(2 * Math.PI * u2);
    }
    canaux.push(canal);
  }
  return { fs: fe, canaux };
}

function construireCalibrationTxt(splParVoie) {
  let texte = "Fichier de metadonnees genere pour les tests automatises.\n";
  for (let v = 0; v < splParVoie.length; v++) {
    const val = splParVoie[v];
    texte += `voie ${v}, SPL_pleine_echelle (dB) = ${val === null ? "A_COMPLETER" : val.toFixed(1)}\n`;
  }
  return texte;
}

function ecrireWavFichier(cheminFichier, sampleRate, canaux) {
  fs.writeFileSync(cheminFichier, construireWav(sampleRate, canaux));
}

module.exports = { construireWav, genererTonPur, genererBruitBlanc, construireCalibrationTxt, ecrireWavFichier, amplitudePourNiveauDbfs };
