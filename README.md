# These_AC_Audio_analyzer
Audio analyzer modul to read and post process the audio file recorded by the Home-made audio recorder 

## Outils complémentaires

- `outils/cabine-3d/` : vue 3D d'une cabine de H145 avec quatre microphones et la carte des
  niveaux sonores interpolés (page autonome, voir `outils/cabine-3d/LISEZMOI.md`).

## Atténuation d'un casque antibruit

Vue « Atténuation d'un casque » de `index.html` (bouton en haut de page, ou `index.html#casque`).
Banc : enceinte fixe en bruit rose, un micro sous le casque, un micro de référence hors du casque.
Déposer un fichier sans casque, un fichier par pose avec casque (3 à 5 poses, casque retiré puis
remis) et, si possible, un fichier de bruit de fond (enceinte coupée).

- Atténuation par tiers d'octave : IL = [Lréf − Lmicro]avec − [Lréf − Lmicro]sans. La référence
  compense les variations de niveau de l'enceinte ; sensibilités et étalonnage s'annulent.
- Moyenne, écart-type et min/max entre poses ; bandes à moins de 10 dB du bruit de fond signalées
  (valeur minorée ou inexploitable).
- Atténuation globale en dB(A), valable pour le bruit rose de l'essai uniquement.
- Export PNG des figures, CSV du tableau, impression PDF.
