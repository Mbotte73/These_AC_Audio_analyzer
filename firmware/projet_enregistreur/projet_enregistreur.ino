/*
  Enregistreur acoustique 4 voies, Teensy 4.1
  Programme d'enregistrement reel.

  Historique de construction :
    Etape 1 : liaison serie.
    Etape 2 : clignotement de la LED embarquee.
    Etape 3 : lecture du bouton poussoir.
    Etape 4 : carte microSD, ecriture et relecture d'un fichier de test.
    Etape 5 : entree I2S quatre voies, affichage du niveau crete.
    Etape 6 : enregistrement reel quatre voies, fichier WAV, LED d'etat.
    Etape 7 : robustesse finale, nom date et heure, sauvegarde periodique,
              recuperation automatique de la carte SD.

  Cablage :
    Teensy 23 -> resistance 100 ohms -> MCLK, dérive vers les deux cartes
    Teensy 21 -------------------------> BCLK, dérive vers les deux cartes
    Teensy 20 -------------------------> LRCK, dérive vers les deux cartes
    Teensy  8 -------------------------> DATA carte A (voies 0 et 1)
    Teensy  6 -------------------------> DATA carte B (voies 2 et 3)
    Vin Teensy -------------------------> VDD des deux cartes
    GND Teensy -------------------------> GND des deux cartes

  Voie 0 = micro 1 (L_IN carte A)
  Voie 1 = micro 2 (R_IN carte A)
  Voie 2 = micro 3 (L_IN carte B)
  Voie 3 = micro 4 (R_IN carte B)

  Commandes :
    bouton, broche 9 vers GND : premier appui demarre l'enregistrement,
                                second appui l'arrete, et ainsi de suite
    LED, broche 2 : voir les codes ci-dessous

  Codes LED :
    allumee fixe        : pret, aucun fichier ouvert, coupure sans risque
    clignotement 1 Hz    : enregistrement en cours
    clignotement 4 Hz    : enregistrement en cours, saturation detectee
    trois clignotements rapides puis fixe : fichier venant d'etre sauvegarde
    clignotement 10 Hz   : erreur carte SD, aucun enregistrement possible

  IMPORTANT : ne jamais couper l'alimentation pendant que la LED clignote,
  le fichier WAV ne serait pas ferme proprement et resterait illisible.

  Chaque enregistrement produit deux fichiers, dans un dossier nomme
  AAAAMMJJ d'apres la date du jour, si l'horloge est synchronisee :
    HHMMSS.WAV   le signal audio brut, 4 voies, 16 bits, 44100 Hz
    HHMMSS.TXT   les metadonnees, avec un champ a completer par voie
                 apres l'etalonnage, pour convertir les echantillons en
                 pascals lors du depouillement. Voir le corps du message
                 qui accompagne ce code pour la formule de conversion.

  Sans horloge synchronisee, repli automatique sur REC0001.WAV, REC0002.WAV,
  etc. a la racine de la carte, comme dans les versions precedentes.

  L'entete du fichier WAV est reecrite toutes les 5 secondes pendant
  l'enregistrement : en cas de coupure d'alimentation imprevue, le fichier
  reste lisible jusqu'a la derniere sauvegarde, plutot que totalement
  corrompu. Cela ne dispense pas d'arreter proprement au bouton avant de
  couper l'alimentation, c'est une protection supplementaire, pas un
  remplacement de cette regle.

  Si la carte SD est signalee en erreur, un appui sur le bouton relance
  une tentative de detection avant de redemarrer le boitier.
*/

#include <Audio.h>
#include <SD.h>
#include <TimeLib.h>

// Horloge temps reel integree au Teensy 4.1. Fonctionne sans pile, mais se
// reinitialise alors a chaque coupure d'alimentation. Avec une pile CR2032
// sur la broche VBAT, l'heure reste correcte entre deux sessions.
time_t getTeensy3Time() {
  return Teensy3Clock.get();
}

// L'horloge peut techniquement repondre "synchronisee" tout en renvoyant
// une date par defaut du matériel (1er janvier 2019 par exemple) si elle a
// ete privee de toute alimentation, USB et pile, meme brievement. Ce test
// ecarte ce cas plutot que de faire confiance a timeSet seul.
bool horlogeFiable() {
  return timeStatus() == timeSet && year() >= 2024 && year() <= 2099;
}

// ======================================================== calibration
// ================================================================
// MODIFIEZ CES QUATRE VALEURS APRES CHAQUE ETALONNAGE
// ================================================================
// Calcul : SPL_pleine_echelle = niveau_injecte - dBFS_mesure
// (dBFS_mesure = la crete relevee sur le moniteur serie pendant
// l'exposition au calibrateur, niveau_injecte = 94 ou 114 selon le
// reglage du calibrateur, voir la procedure de calibration)
//
// Laissez NAN pour une voie non encore calibree : le fichier de
// metadonnees affichera alors A_COMPLETER pour cette voie, comme avant.
//
// Apres modification : reprogrammez la carte, puis committez ce fichier
// sur Git avec un message du type "Etalonnage du 2026-09-20", pour
// garder un historique date de chaque calibration.
const float CAL_VOIE_0 = NAN;   // exemple une fois calibre : 133.42f
const float CAL_VOIE_1 = NAN;
const float CAL_VOIE_2 = NAN;
const float CAL_VOIE_3 = NAN;

const float calibrationVoie[4] = { CAL_VOIE_0, CAL_VOIE_1, CAL_VOIE_2, CAL_VOIE_3 };

void afficherCalibrationActuelle() {
  Serial.println("Calibration actuelle (codee dans le programme) :");
  for (int v = 0; v < 4; v++) {
    Serial.print("  voie "); Serial.print(v); Serial.print(" : ");
    if (isnan(calibrationVoie[v])) Serial.println("non calibree");
    else { Serial.print(calibrationVoie[v], 2); Serial.println(" dB"); }
  }
}

const int PIN_LED    = 2;
const int PIN_BOUTON = 9;
const uint32_t ANTIREBOND_MS = 50;

const uint16_t NB_VOIES  = 4;
const uint32_t FE        = 44100;   // fixe par la bibliotheque audio Teensy
const uint16_t NB_BITS   = 16;
const int16_t  SEUIL_SAT = 32000;   // au dela, ecretage considere atteint

AudioInputI2SQuad i2sQuad;
AudioRecordQueue  q0, q1, q2, q3;
AudioConnection   c0(i2sQuad, 0, q0, 0);   // voie 0, micro 1
AudioConnection   c1(i2sQuad, 1, q1, 0);   // voie 1, micro 2
AudioConnection   c2(i2sQuad, 2, q2, 0);   // voie 2, micro 3
AudioConnection   c3(i2sQuad, 3, q3, 0);   // voie 3, micro 4

// ----------------------------------------------------------------- etat
File     fichierWav;
bool     enregistre     = false;
bool     erreurSd       = false;
bool     saturation     = false;
uint32_t octetsData     = 0;
uint32_t nbSaturations  = 0;
uint32_t nbPertes       = 0;
int16_t  creteVoie[NB_VOIES] = {0, 0, 0, 0};
char     nomFichierActuel[24] = "";

// confirmation visuelle apres fermeture d'un fichier
bool     confirmationEnCours = false;
uint32_t debutConfirmation   = 0;
const uint32_t DUREE_CONFIRMATION_MS = 1200;   // 3 clignotements rapides

// sauvegarde periodique de l'entete pendant l'enregistrement : en cas de
// coupure d'alimentation imprevue, le fichier reste lisible jusqu'au
// dernier point de sauvegarde plutot que d'etre entierement corrompu
uint32_t dernierFlushEntete = 0;
const uint32_t INTERVALLE_FLUSH_MS = 5000;

// recuperation automatique de la carte SD, sans intervention humaine
uint32_t dernierEssaiRecuperationSd = 0;
const uint32_t INTERVALLE_RETRY_SD_MS = 5000;
bool     enregistrementAReprendre = false;   // etait actif au moment de l'erreur

uint8_t  tampon[16384];      // environ 46 ms de marge d'ecriture, 4 voies
uint32_t idxTampon = 0;

// ============================================================== entete WAV
void ecrireEnteteWav(File &f, uint32_t octets) {
  uint8_t h[44];
  uint32_t byteRate   = FE * NB_VOIES * NB_BITS / 8;
  uint16_t blockAlign = NB_VOIES * NB_BITS / 8;
  uint32_t riffSize   = 36 + octets;

  memcpy(h + 0,  "RIFF", 4);
  memcpy(h + 4,  &riffSize, 4);
  memcpy(h + 8,  "WAVE", 4);
  memcpy(h + 12, "fmt ", 4);
  uint32_t fmtSize = 16;       memcpy(h + 16, &fmtSize, 4);
  uint16_t format  = 1;        memcpy(h + 20, &format, 2);
  uint16_t nch     = NB_VOIES; memcpy(h + 22, &nch, 2);
  uint32_t fe      = FE;       memcpy(h + 24, &fe, 4);
                               memcpy(h + 28, &byteRate, 4);
                               memcpy(h + 32, &blockAlign, 2);
  uint16_t bits    = NB_BITS;  memcpy(h + 34, &bits, 2);
  memcpy(h + 36, "data", 4);   memcpy(h + 40, &octets, 4);

  f.seek(0);
  f.write(h, 44);
}

// ========================================================== nom de fichier
void nomFichierSuivant(char *nom, int taille) {
  for (int i = 1; i < 10000; i++) {
    snprintf(nom, taille, "REC%04d.WAV", i);
    if (!SD.exists(nom)) return;
  }
  strcpy(nom, "REC9999.WAV");
}

// Construit un nom d'enregistrement date, sous la forme AAAAMMJJ/HHMMSS.WAV,
// un dossier par jour. Si deux enregistrements demarrent la meme seconde,
// un suffixe _2, _3, etc. est ajoute. Si l'horloge n'est pas synchronisee,
// repli automatique sur la numerotation sequentielle a la racine.
// Retourne false uniquement si aucun nom libre n'a pu etre construit.
bool construireNomEnregistrement(char *nom, int taille) {
  if (!horlogeFiable()) {
    nomFichierSuivant(nom, taille);
    return true;
  }

  char dossier[9];
  snprintf(dossier, sizeof(dossier), "%04d%02d%02d", year(), month(), day());
  if (!SD.exists(dossier) && !SD.mkdir(dossier)) return false;

  char base[20];
  snprintf(base, sizeof(base), "%s/%02d%02d%02d", dossier, hour(), minute(), second());

  snprintf(nom, taille, "%s.WAV", base);
  if (!SD.exists(nom)) return true;

  for (int suffixe = 2; suffixe <= 9; suffixe++) {
    snprintf(nom, taille, "%s_%d.WAV", base, suffixe);
    if (!SD.exists(nom)) return true;
  }
  return false;   // cas extreme, plus de neuf enregistrements a la meme seconde
}

// ================================================== fichier de metadonnees
void ecrireMetadonnees(const char *nomWav, uint32_t dureeMs) {
  char nomTxt[24];
  strcpy(nomTxt, nomWav);
  int lg = strlen(nomTxt);
  if (lg >= 4) { nomTxt[lg - 3] = 'T'; nomTxt[lg - 2] = 'X'; nomTxt[lg - 1] = 'T'; }

  File f = SD.open(nomTxt, FILE_WRITE);
  if (!f) { Serial.println("ATTENTION : fichier de metadonnees non cree."); return; }

  f.println("Fichier audio associe : "); f.println(nomWav);

  f.print("Date et heure : ");
  if (horlogeFiable()) {
    char horodatage[20];
    snprintf(horodatage, sizeof(horodatage), "%04d-%02d-%02d %02d:%02d:%02d",
             year(), month(), day(), hour(), minute(), second());
    f.println(horodatage);
  } else {
    f.println("NON DISPONIBLE, horloge non synchronisee");
  }
  f.print("Frequence d'echantillonnage (Hz) : "); f.println(FE);
  f.print("Nombre de voies : ");             f.println(NB_VOIES);
  f.print("Resolution (bits) : ");           f.println(NB_BITS);
  f.print("Duree (ms) : ");                  f.println(dureeMs);
  f.println();
  f.println("Affectation des voies :");
  f.println("  voie 0 = micro 1 (L_IN carte A)");
  f.println("  voie 1 = micro 2 (R_IN carte A)");
  f.println("  voie 2 = micro 3 (L_IN carte B)");
  f.println("  voie 3 = micro 4 (R_IN carte B)");
  f.println();
  f.println("Crete par voie, en dBFS relatif a la pleine echelle numerique :");
  for (int i = 0; i < NB_VOIES; i++) {
    f.print("  voie "); f.print(i); f.print(" : ");
    f.println(20.0f * log10f((float)creteVoie[i] / 32768.0f), 1);
  }
  f.println();
  f.println("Calibration, a completer apres etalonnage :");
  f.println("  Injecter un niveau connu (ex. 94 dB SPL) et noter le dBFS obtenu.");
  f.println("  SPL_pleine_echelle = niveau_injecte - dBFS_mesure");
  f.println("  p(t) = (echantillon / 32768) * 20e-6 * 10^(SPL_pleine_echelle / 20)");
  for (int v = 0; v < 4; v++) {
    f.print("  voie "); f.print(v); f.print(", SPL_pleine_echelle (dB) = ");
    if (isnan(calibrationVoie[v])) f.println("A_COMPLETER");
    else f.println(calibrationVoie[v], 2);
  }
  f.println();
  f.print("Blocs perdus pendant l'enregistrement : "); f.println(nbPertes);
  f.print("Echantillons satures : ");                  f.println(nbSaturations);

  f.close();
}

// ============================================================== demarrage
void demarrerEnregistrement() {
  if (!construireNomEnregistrement(nomFichierActuel, sizeof(nomFichierActuel))) {
    erreurSd = true;
    Serial.println("ERREUR : impossible de creer un nom de fichier sur la carte SD.");
    return;
  }
  fichierWav = SD.open(nomFichierActuel, FILE_WRITE);
  if (!fichierWav) { erreurSd = true; return; }

  ecrireEnteteWav(fichierWav, 0);   // entete provisoire, corrigee a l'arret

  octetsData = 0;  idxTampon = 0;
  nbSaturations = 0;  nbPertes = 0;  saturation = false;
  for (int i = 0; i < NB_VOIES; i++) creteVoie[i] = 0;
  dernierFlushEntete = millis();

  q0.begin(); q1.begin(); q2.begin(); q3.begin();
  enregistre = true;

  Serial.print("Enregistrement dans "); Serial.println(nomFichierActuel);
}

// ================================================================= arret
void arreterEnregistrement() {
  uint32_t debutFermeture = millis();
  enregistre = false;
  q0.end(); q1.end(); q2.end(); q3.end();

  if (idxTampon > 0) {
    fichierWav.write(tampon, idxTampon);
    octetsData += idxTampon;
    idxTampon = 0;
  }
  ecrireEnteteWav(fichierWav, octetsData);
  fichierWav.close();

  uint32_t dureeMs = (uint32_t)(1000.0f * (float)octetsData / (float)(FE * NB_VOIES * NB_BITS / 8));
  ecrireMetadonnees(nomFichierActuel, dureeMs);

  Serial.print("Duree (s) : ");
  Serial.println((float)octetsData / (FE * NB_VOIES * NB_BITS / 8), 2);
  for (int i = 0; i < NB_VOIES; i++) {
    Serial.print("Voie "); Serial.print(i);
    Serial.print(" crete = "); Serial.print(creteVoie[i]);
    Serial.print(" soit ");
    Serial.print(20.0f * log10f((float)creteVoie[i] / 32768.0f), 1);
    Serial.println(" dBFS");
  }
  Serial.print("Echantillons satures : "); Serial.println(nbSaturations);
  Serial.print("Blocs perdus : ");         Serial.println(nbPertes);

  confirmationEnCours = true;
  debutConfirmation   = debutFermeture;
}

// ================================================ arret d'urgence, panne SD
void arretUrgenceSd() {
  enregistre = false;
  enregistrementAReprendre = true;   // pour reprise automatique apres recuperation
  q0.end(); q1.end(); q2.end(); q3.end();
  fichierWav.close();     // au mieux, la carte est deja en defaut
  erreurSd = true;
  Serial.println("ERREUR SD pendant l'enregistrement, arret d'urgence.");
}

// ============================================ recuperation de la carte SD
// Appelee a la fois par un appui bouton et automatiquement en arriere-plan,
// pour que le systeme se retablisse seul si personne n'est present pour
// intervenir. Reprend aussi l'enregistrement s'il avait ete interrompu.
void tenterRecuperationSd() {
  Serial.println("Tentative de detection de la carte SD...");
  if (!SD.begin(BUILTIN_SDCARD)) {
    Serial.println("Toujours indisponible.");
    return;
  }
  erreurSd = false;
  Serial.println("Carte SD de nouveau disponible.");

  if (enregistrementAReprendre) {
    enregistrementAReprendre = false;
    Serial.println("Reprise automatique de l'enregistrement.");
    demarrerEnregistrement();
  }
}

// ========================================= sauvegarde periodique de l'entete
void verifierFlushPeriodique() {
  uint32_t maintenant = millis();
  if (maintenant - dernierFlushEntete < INTERVALLE_FLUSH_MS) return;
  dernierFlushEntete = maintenant;

  if (idxTampon > 0) {
    if (fichierWav.write(tampon, idxTampon) != (int)idxTampon) { arretUrgenceSd(); return; }
    octetsData += idxTampon;
    idxTampon = 0;
  }

  ecrireEnteteWav(fichierWav, octetsData);   // rend le fichier lisible tel quel
  fichierWav.flush();
  fichierWav.seek(44 + octetsData);          // reprise juste apres les donnees confirmees
}

// ============================================== transfert des quatre voies
void transfererBlocs() {
  while (q0.available() > 0 && q1.available() > 0
                            && q2.available() > 0 && q3.available() > 0) {

    int16_t *v0 = (int16_t *)q0.readBuffer();
    int16_t *v1 = (int16_t *)q1.readBuffer();
    int16_t *v2 = (int16_t *)q2.readBuffer();
    int16_t *v3 = (int16_t *)q3.readBuffer();
    int16_t *sortie = (int16_t *)(tampon + idxTampon);

    for (int i = 0; i < AUDIO_BLOCK_SAMPLES; i++) {
      sortie[4 * i + 0] = v0[i];
      sortie[4 * i + 1] = v1[i];
      sortie[4 * i + 2] = v2[i];
      sortie[4 * i + 3] = v3[i];

      int16_t a0 = abs(v0[i]), a1 = abs(v1[i]), a2 = abs(v2[i]), a3 = abs(v3[i]);
      if (a0 > creteVoie[0]) creteVoie[0] = a0;
      if (a1 > creteVoie[1]) creteVoie[1] = a1;
      if (a2 > creteVoie[2]) creteVoie[2] = a2;
      if (a3 > creteVoie[3]) creteVoie[3] = a3;
      if (a0 > SEUIL_SAT || a1 > SEUIL_SAT || a2 > SEUIL_SAT || a3 > SEUIL_SAT) {
        nbSaturations++;  saturation = true;
      }
    }

    q0.freeBuffer(); q1.freeBuffer(); q2.freeBuffer(); q3.freeBuffer();
    idxTampon += AUDIO_BLOCK_SAMPLES * NB_VOIES * 2;

    if (idxTampon + AUDIO_BLOCK_SAMPLES * NB_VOIES * 2 > sizeof(tampon)) {
      if (fichierWav.write(tampon, idxTampon) != (int)idxTampon) { arretUrgenceSd(); return; }
      octetsData += idxTampon;
      idxTampon = 0;
    }
  }

  if (q0.available() > 45 || q1.available() > 45
                          || q2.available() > 45 || q3.available() > 45) {
    nbPertes++;
  }
}

// ================================================================= bouton
// Debounce robuste : un changement n'est valide que si le niveau reste
// stable pendant toute la fenetre d'antirebond, pas seulement des qu'un
// certain temps s'est ecoule depuis le dernier changement observe. Cela
// evite qu'un parasite bref ne fasse ignorer un vrai appui juste apres.
bool boutonAppuye() {
  static bool     dernierEtatLu     = HIGH;
  static bool     etatStable        = HIGH;
  static uint32_t depuisChangement  = 0;

  uint32_t maintenant = millis();
  bool etat = digitalRead(PIN_BOUTON);

  if (etat != dernierEtatLu) {
    dernierEtatLu    = etat;
    depuisChangement = maintenant;
  }

  if (maintenant - depuisChangement >= ANTIREBOND_MS && etatStable != dernierEtatLu) {
    etatStable = dernierEtatLu;
    if (etatStable == LOW) return true;
  }
  return false;
}

// ==================================================================== LED
void gererLed() {
  uint32_t maintenant = millis();

  if (erreurSd) {
    digitalWrite(PIN_LED, (maintenant % 100) < 50);   // 10 Hz
    return;
  }

  if (confirmationEnCours) {
    if (maintenant - debutConfirmation >= DUREE_CONFIRMATION_MS) {
      confirmationEnCours = false;
      digitalWrite(PIN_LED, HIGH);
    } else {
      digitalWrite(PIN_LED, ((maintenant - debutConfirmation) % 200) < 100);
    }
    return;
  }

  if (!enregistre) { digitalWrite(PIN_LED, HIGH); return; }

  uint32_t periode = saturation ? 250 : 1000;   // 4 Hz si saturation, sinon 1 Hz
  digitalWrite(PIN_LED, (maintenant % periode) < (periode / 2));
}

// ========================================== test d'ecriture reel au demarrage
// SD.begin() confirme seulement que la carte repond, pas qu'elle accepte
// l'ecriture. Une carte protegee ou partiellement defaillante peut passer
// SD.begin() puis echouer au premier vrai enregistrement. Ce test ecrit,
// relit et efface un petit fichier marqueur pour verifier reellement.
bool testerEcritureSd() {
  const char *nom = "TEST.TXT";
  SD.remove(nom);
  File f = SD.open(nom, FILE_WRITE);
  if (!f) return false;
  f.print("test");
  f.close();

  f = SD.open(nom, FILE_READ);
  if (!f) return false;
  bool ok = f.available() > 0;
  f.close();
  SD.remove(nom);
  return ok;
}

// ================================================================== setup
void setup() {
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BOUTON, INPUT_PULLUP);

  Serial.begin(115200);
  delay(1500);
  Serial.println("Enregistreur 4 voies pret.");

  setSyncProvider(getTeensy3Time);
  if (!horlogeFiable()) {
    Serial.println("ATTENTION : horloge non synchronisee ou date invraisemblable.");
    Serial.println("Les fichiers seront quand meme numerotes normalement, mais sans date fiable.");
  } else {
    Serial.print("Horloge OK, date et heure actuelles : ");
    Serial.print(year()); Serial.print("-"); Serial.print(month()); Serial.print("-"); Serial.print(day());
    Serial.print(" "); Serial.print(hour()); Serial.print(":"); Serial.println(minute());
  }

  AudioMemory(600);   // marge confortable, la RAM disponible le permet largement

  afficherCalibrationActuelle();

  if (!SD.begin(BUILTIN_SDCARD)) {
    erreurSd = true;
    Serial.println("ERREUR : carte SD absente ou illisible.");
  } else if (!testerEcritureSd()) {
    erreurSd = true;
    Serial.println("ERREUR : carte SD detectee mais ecriture impossible.");
  }
}

// =================================================================== loop
void loop() {
  if (boutonAppuye()) {
    if (erreurSd) {
      tenterRecuperationSd();
    } else if (!enregistre) {
      demarrerEnregistrement();
    } else {
      arreterEnregistrement();
    }
  }

  // recuperation automatique en arriere-plan, sans attendre un appui
  // bouton, indispensable pour un fonctionnement sans operateur present
  if (erreurSd) {
    uint32_t maintenant = millis();
    if (maintenant - dernierEssaiRecuperationSd >= INTERVALLE_RETRY_SD_MS) {
      dernierEssaiRecuperationSd = maintenant;
      tenterRecuperationSd();
    }
  }

  if (enregistre) transfererBlocs();
  if (enregistre) verifierFlushPeriodique();

  gererLed();
}
