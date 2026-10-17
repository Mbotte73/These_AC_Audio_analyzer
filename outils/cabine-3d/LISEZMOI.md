# Cabine H145 en 3D, niveaux sonores

Page autonome (un seul fichier, fonctionne hors ligne) : `cabine_H145_niveaux_sonores.html`.
L'ouvrir par double-clic dans Chrome ou Edge.

Quatre microphones placés dans la cabine ; le niveau sonore est estimé partout par
interpolation en énergie entre leurs quatre niveaux (méthode de Shepard). Ce n'est pas un
calcul d'acoustique. Les niveaux peuvent être collés depuis l'onglet Comparaison de l'analyseur.

Deux rendus, au choix dans le panneau : Futuriste (lignes, léger) et Réaliste (textures, ombres,
reflets ; plus exigeant pour la carte graphique).

Données Airbus utilisées (H145 D-3) : volume cabine et soute 6,03 m³, rotor 10,80 m à 5 pales,
longueur hors tout 13,54 m rotor tournant, moyeu à 3,62 m et dérive à 4,00 m du sol, voie du
train 2,40 m. Les autres formes sont relevées sur une photo ou génériques : voir « Hypothèses et
limites » dans la page.

## Modifier la page

- Code source lisible : `source/cabine_template.html` (le marqueur `/*THREE*/` reçoit three.js).
- Reconstruire la page après modification :

      npm install
      npm run construire-cabine

  three.js est fixé à la version 0.160.0 (`package.json`), celle avec laquelle la page est validée.
- Tests : `npx playwright test tests/cabine-3d.spec.js` (niveaux, volume, contenance de la
  carrosserie, cotes Airbus, couleurs de la tranche, bascule entre les rendus).
