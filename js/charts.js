"use strict";
/* =========================================================================
   CHARTS.JS — trace en Canvas natif (aucune bibliotheque de graphiques) :
   courbes (1 ou plusieurs series superposees, axes lineaire/log a
   graduation complete), barres (tiers d'octave), spectrogramme (heatmap),
   et export PNG generique de n'importe quel canvas.
   ========================================================================= */

const PALETTE_VOIES = ["#0f4c5c", "#c98a3b", "#7a3b8a", "#2e8b57"];

function preparerCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w*dpr; canvas.height = h*dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

/* --------------------------------------------------------------- ticks */
function ticksLineaires(min, max, nCible) {
  nCible = nCible || 6;
  if (!isFinite(min) || !isFinite(max)) return [0];
  if (max <= min) max = min + 1;
  const range = max - min;
  const rawStep = range / nCible;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step;
  if (norm < 1.5) step = 1*mag; else if (norm < 3) step = 2*mag; else if (norm < 7) step = 5*mag; else step = 10*mag;
  const start = Math.ceil((min - 1e-9) / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step*1e-6; v += step) ticks.push(Math.round(v/step)*step);
  return ticks.length ? ticks : [min, max];
}

/* Graduations aux decades et aux multiples 1/2/5 de chaque decade. */
function ticksLog(min, max) {
  min = Math.max(min, 1e-6);
  const k0 = Math.floor(Math.log10(min)), k1 = Math.ceil(Math.log10(max));
  const ticks = [];
  for (let k = k0; k <= k1; k++) {
    for (const m of [1,2,5]) {
      const v = m * Math.pow(10, k);
      if (v >= min*0.999 && v <= max*1.001) ticks.push(v);
    }
  }
  return ticks;
}

function formatHz(v) {
  if (v >= 1000) {
    const k = v/1000;
    return (Math.round(k*100)/100).toString().replace(/\.00$/,"") + "k";
  }
  return (Math.round(v*100)/100).toString();
}

/* ------------------------------------------------------- export PNG */
function exporterCanvasPng(canvas, nomFichier) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = nomFichier.endsWith(".png") ? nomFichier : nomFichier + ".png";
  a.click();
}

function boutonExportCanvas(canvas, nomFichierFn) {
  const btn = document.createElement("button");
  btn.className = "btn-export no-print";
  btn.type = "button";
  btn.textContent = "Exporter en PNG";
  btn.addEventListener("click", () => exporterCanvasPng(canvas, typeof nomFichierFn === "function" ? nomFichierFn() : nomFichierFn));
  return btn;
}

/* --------------------------------------------------------- courbe(s) */
/* series : [{ xs, ys, couleur, label, tirets? }]
   opts   : { titre, xlabel, ylabel, logX, xMin, xMax, yMin, yMax, formatX } */
function tracerCourbe(canvas, series, opts) {
  opts = opts || {};
  const { ctx, w, h } = preparerCanvas(canvas);
  const legende = series.length > 1;
  const M = { l: 52, r: 16, t: legende ? 40 : 26, b: 40 };
  ctx.clearRect(0,0,w,h);
  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#20242b";
  ctx.fillText(opts.titre || "", M.l, 16);

  const logX = !!opts.logX;
  let finiteYs = [];
  for (const s of series) for (const v of s.ys) if (isFinite(v)) finiteYs.push(v);
  let yMin = opts.yMin ?? Math.min(...finiteYs), yMax = opts.yMax ?? Math.max(...finiteYs);
  if (!isFinite(yMin) || !isFinite(yMax)) { yMin = 0; yMax = 1; }
  if (yMax - yMin < 1) { yMax += 0.5; yMin -= 0.5; }
  const xMin = opts.xMin ?? series[0].xs[0], xMax = opts.xMax ?? series[0].xs[series[0].xs.length-1];

  function px(x) {
    if (logX) return M.l + (Math.log10(Math.max(x,1e-6))-Math.log10(xMin))/(Math.log10(xMax)-Math.log10(xMin))*(w-M.l-M.r);
    return M.l + (x-xMin)/(xMax-xMin)*(w-M.l-M.r);
  }
  function py(y) { return h-M.b - (y-yMin)/(yMax-yMin)*(h-M.t-M.b); }

  // grille + graduations Y
  const ticksY = ticksLineaires(yMin, yMax, 6);
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const val of ticksY) {
    const y = py(val);
    ctx.strokeStyle = "#eeece6"; ctx.beginPath(); ctx.moveTo(M.l,y); ctx.lineTo(w-M.r,y); ctx.stroke();
    ctx.fillStyle = "#5b6270";
    ctx.fillText(val.toFixed(0), M.l-6, y);
  }

  // graduations X
  const ticksX = logX ? ticksLog(xMin, xMax) : ticksLineaires(xMin, xMax, 8);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const val of ticksX) {
    const x = px(val);
    if (x < M.l-1 || x > w-M.r+1) continue;
    ctx.strokeStyle = "#f2f0eb"; ctx.beginPath(); ctx.moveTo(x,M.t); ctx.lineTo(x,h-M.b); ctx.stroke();
    ctx.strokeStyle = "#c8c4ba"; ctx.beginPath(); ctx.moveTo(x,h-M.b); ctx.lineTo(x,h-M.b+4); ctx.stroke();
    ctx.fillStyle = "#5b6270";
    const label = opts.formatX ? opts.formatX(val) : val.toFixed(val<10 && val!==Math.round(val) ? 1 : 0);
    ctx.fillText(label, x, h-M.b+6);
  }

  // axes
  ctx.strokeStyle = "#20242b"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, h-M.b); ctx.lineTo(w-M.r, h-M.b); ctx.stroke();

  // courbes
  for (const s of series) {
    ctx.strokeStyle = s.couleur || "#0f4c5c"; ctx.lineWidth = 1.5;
    ctx.setLineDash(s.tirets || []);
    ctx.beginPath();
    let started = false;
    for (let i=0;i<s.xs.length;i++){
      if (!isFinite(s.ys[i])) { started = false; continue; }
      const x = px(s.xs[i]), y = py(s.ys[i]);
      if (!started) { ctx.moveTo(x,y); started = true; } else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // legende
  if (legende) {
    let lx = M.l;
    ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = "12px sans-serif";
    for (const s of series) {
      ctx.strokeStyle = s.couleur; ctx.lineWidth = 2.5;
      ctx.setLineDash(s.tirets || []);
      ctx.beginPath(); ctx.moveTo(lx, 28); ctx.lineTo(lx+18, 28); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#20242b";
      ctx.fillText(s.label || "", lx+22, 29);
      lx += 22 + ctx.measureText(s.label || "").width + 20;
    }
  }

  // labels d'axes
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.font = "12px sans-serif";
  ctx.fillStyle = "#5b6270";
  ctx.fillText(opts.xlabel || "", w-M.r-90, h-4);
  if (opts.ylabel) {
    ctx.save(); ctx.translate(12, M.t+10); ctx.rotate(-Math.PI/2);
    ctx.fillText(opts.ylabel, 0, 0);
    ctx.restore();
  }
}

/* --------------------------------------------------------------- barres */
function tracerBarres(canvas, labels, values, opts) {
  opts = opts || {};
  const { ctx, w, h } = preparerCanvas(canvas);
  const M = { l: 46, r: 12, t: 26, b: 54 };
  ctx.clearRect(0,0,w,h);
  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#20242b";
  ctx.fillText(opts.titre || "", M.l, 16);

  const finite = values.filter(v=>isFinite(v));
  const sommet = finite.length ? Math.max(...finite) : 0;
  const plancher = finite.length ? Math.min(...finite) : 0;
  const yMax = sommet+6, yMin = Math.min(plancher-6, sommet-70);

  function py(y){ return h-M.b - (Math.max(y,yMin)-yMin)/(yMax-yMin)*(h-M.t-M.b); }

  const ticksY = ticksLineaires(yMin, yMax, 6);
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const val of ticksY) {
    const y = py(val);
    ctx.strokeStyle = "#eeece6"; ctx.beginPath(); ctx.moveTo(M.l,y); ctx.lineTo(w-M.r,y); ctx.stroke();
    ctx.fillStyle = "#5b6270"; ctx.fillText(val.toFixed(0), M.l-6, y);
  }

  ctx.strokeStyle = "#20242b"; ctx.beginPath(); ctx.moveTo(M.l,M.t); ctx.lineTo(M.l,h-M.b); ctx.lineTo(w-M.r,h-M.b); ctx.stroke();

  const bw = (w-M.l-M.r)/values.length;
  ctx.fillStyle = "#c98a3b";
  for (let i=0;i<values.length;i++){
    if (!isFinite(values[i])) continue;
    const x = M.l + i*bw + bw*0.15;
    const yTop = py(values[i]);
    ctx.fillRect(x, yTop, bw*0.7, (h-M.b)-yTop);
  }

  ctx.fillStyle = "#5b6270"; ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.font = "10px sans-serif";
  for (let i=0;i<labels.length;i++){
    const x = M.l + i*bw + bw*0.5;
    ctx.save(); ctx.translate(x, h-M.b+6); ctx.rotate(-Math.PI/3);
    ctx.fillText(String(labels[i]), 0, 0);
    ctx.restore();
  }
}

/* ============================================================ spectrogramme */
function couleurDb(v, vmin, vmax) {
  let t = (v - vmin) / (vmax - vmin || 1);
  t = Math.min(Math.max(t, 0), 1);
  // degrade multi-points bleu fonce -> cyan -> vert -> jaune -> rouge
  const stops = [
    [0.00, 15, 20, 60],
    [0.25, 20, 90, 150],
    [0.50, 40, 170, 120],
    [0.75, 235, 200, 40],
    [1.00, 210, 40, 30],
  ];
  let i = 0; while (i < stops.length-2 && t > stops[i+1][0]) i++;
  const [t0,r0,g0,b0] = stops[i], [t1,r1,g1,b1] = stops[i+1];
  const f = (t - t0) / (t1 - t0 || 1);
  const r = Math.round(r0 + f*(r1-r0)), g = Math.round(g0 + f*(g1-g0)), b = Math.round(b0 + f*(b1-b0));
  return `rgb(${r},${g},${b})`;
}

/* freqs, temps, trames : sortie de calculerStft. correctionDb(f) optionnelle
   (reponse du capteur) appliquee par bin avant conversion en dB. */
function tracerSpectrogramme(canvas, freqs, temps, trames, opts) {
  opts = opts || {};
  const { ctx, w, h } = preparerCanvas(canvas);
  const M = { l: 52, r: 66, t: 26, b: 40 };
  ctx.clearRect(0,0,w,h);
  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#20242b";
  ctx.fillText(opts.titre || "", M.l, 16);

  if (!trames.length) { ctx.fillStyle="#5b6270"; ctx.fillText("Pas assez d'echantillons pour cette taille de fenetre.", M.l, h/2); return; }

  const nFrames = trames.length, nBins = freqs.length;
  const fMax = opts.fMax || freqs[freqs.length-1];
  let nBinsAff = nBins; while (nBinsAff>1 && freqs[nBinsAff-1] > fMax) nBinsAff--;

  const pref2 = PREF*PREF;
  const dbMat = new Float64Array(nFrames*nBinsAff);
  let vmin = Infinity, vmax = -Infinity;
  for (let i=0;i<nFrames;i++){
    const trame = trames[i];
    for (let k=0;k<nBinsAff;k++){
      let p = trame[k];
      if (opts.correctionDb) p *= Math.pow(10, -opts.correctionDb(freqs[k])/10);
      const db = 10*Math.log10(Math.max(p,1e-24)/pref2);
      dbMat[i*nBinsAff+k] = db;
      if (isFinite(db)) { if (db<vmin) vmin=db; if (db>vmax) vmax=db; }
    }
  }
  if (!isFinite(vmin)) { vmin=0; vmax=1; }
  vmin = Math.max(vmin, vmax-80);

  // Une grande taille de fenetre FFT (jusqu'a 65536) donne beaucoup plus de
  // raies que de pixels verticaux disponibles a l'ecran : on regroupe les
  // raies par paquets (niveau max du paquet) pour rester sous une limite
  // raisonnable de memoire image, sans jamais alterer les graduations d'axe
  // (calculees a partir des frequences reelles, independamment du nombre de
  // paquets utilise pour le dessin).
  const MAX_LIGNES = 1024;
  const groupe = Math.max(1, Math.ceil(nBinsAff / MAX_LIGNES));
  const nLignes = Math.ceil(nBinsAff / groupe);

  const off = document.createElement("canvas");
  off.width = nFrames; off.height = nLignes;
  const octx = off.getContext("2d");
  const img = octx.createImageData(nFrames, nLignes);
  for (let i=0;i<nFrames;i++){
    for (let ligne=0; ligne<nLignes; ligne++){
      const kDebut = ligne*groupe, kFin = Math.min(kDebut+groupe, nBinsAff);
      let db = -Infinity;
      for (let k=kDebut;k<kFin;k++) { const v = dbMat[i*nBinsAff+k]; if (v>db) db = v; }
      const col = couleurDb(db, vmin, vmax);
      const [r,g,b] = col.match(/\d+/g).map(Number);
      const row = nLignes-1-ligne; // frequence croissante vers le haut
      const idx = (row*nFrames + i)*4;
      img.data[idx]=r; img.data[idx+1]=g; img.data[idx+2]=b; img.data[idx+3]=255;
    }
  }
  octx.putImageData(img, 0, 0);

  const plotW = w-M.l-M.r-20, plotH = h-M.t-M.b;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, M.l, M.t, plotW, plotH);

  // graduations Y (frequence, lineaire)
  const ticksY = ticksLineaires(0, freqs[nBinsAff-1], 6);
  ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.font="11px sans-serif";
  for (const val of ticksY) {
    const y = M.t + plotH - (val/freqs[nBinsAff-1])*plotH;
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.moveTo(M.l,y); ctx.lineTo(M.l+plotW,y); ctx.stroke();
    ctx.fillStyle = "#5b6270"; ctx.fillText(formatHz(val), M.l-6, y);
  }

  // graduations X (temps, lineaire)
  const tMin = temps[0], tMax = temps[temps.length-1];
  const ticksX = ticksLineaires(tMin, tMax, 8);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const val of ticksX) {
    const x = M.l + (val-tMin)/(tMax-tMin||1)*plotW;
    if (x<M.l-1 || x>M.l+plotW+1) continue;
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.moveTo(x,M.t); ctx.lineTo(x,M.t+plotH); ctx.stroke();
    ctx.fillStyle = "#5b6270"; ctx.fillText(val.toFixed(val<10?1:0), x, M.t+plotH+6);
  }

  ctx.strokeStyle = "#20242b"; ctx.strokeRect(M.l, M.t, plotW, plotH);

  // barre de couleur
  const barX = M.l+plotW+16, barW = 14;
  for (let y=0;y<plotH;y++){
    const t = 1 - y/plotH;
    ctx.fillStyle = couleurDb(vmin + t*(vmax-vmin), vmin, vmax);
    ctx.fillRect(barX, M.t+y, barW, 1);
  }
  ctx.strokeStyle = "#20242b"; ctx.strokeRect(barX, M.t, barW, plotH);
  ctx.textAlign = "left"; ctx.textBaseline="middle"; ctx.fillStyle="#5b6270"; ctx.font="10px sans-serif";
  ctx.fillText(vmax.toFixed(0), barX+barW+3, M.t+4);
  ctx.fillText(vmin.toFixed(0), barX+barW+3, M.t+plotH-4);

  ctx.textAlign="left"; ctx.textBaseline="alphabetic"; ctx.font="12px sans-serif"; ctx.fillStyle="#5b6270";
  ctx.fillText(opts.xlabel || "temps (s)", w-M.r-70, h-4);
  ctx.save(); ctx.translate(14, M.t+plotH/2); ctx.rotate(-Math.PI/2);
  ctx.fillText(opts.ylabel || "fréquence (Hz)", -30, 0);
  ctx.restore();
}
