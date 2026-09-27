"use strict";
/* =========================================================================
   Service worker de la telecommande phyphox.

   Objectif unique : garder une copie locale (cache du navigateur) de la
   page et de ses quelques fichiers, pour qu'elle puisse se rouvrir depuis
   l'icone de l'ecran d'accueil meme sans aucun acces internet — situation
   frequente sur le terrain, une fois le telephone de l'operateur bascule
   sur le reseau Wi-Fi local forme par les telephones phyphox (qui n'a pas
   d'acces internet).

   Important : ce service worker est servi depuis le dossier telecommande/
   et sa portee (scope) par defaut est donc limitee a ce dossier — il ne
   touche jamais aux pages de l'outil d'analyse acoustique, servies depuis
   la racine du meme site.

   Ce fichier ne concerne QUE le chargement de cette page elle-meme. Les
   commandes envoyees aux telephones esclaves (control?cmd=..., export?...)
   partent vers d'autres adresses (les telephones, sur le reseau local),
   dans de nouveaux onglets ouverts par la page : elles ne passent jamais
   par ce service worker (qui ne s'applique qu'aux requetes vers sa propre
   origine) et continuent donc de fonctionner exactement comme avant,
   reseau local ou pas.
*/

// A incrementer (v2, v3...) a chaque modification de la page, pour que les
// telephones deja installes recuperent la nouvelle version des qu'ils ont
// a nouveau du reseau.
const CACHE_NAME = "telecommande-phyphox-v1";

const FICHIERS_A_METTRE_EN_CACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FICHIERS_A_METTRE_EN_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((noms) =>
      Promise.all(noms.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Cache d'abord (priorite a la fiabilite hors ligne), avec mise a jour
// silencieuse du cache en arriere-plan des que le reseau repond — la
// prochaine ouverture profite alors de la version la plus recente.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((reponseEnCache) => {
      const recuperationReseau = fetch(event.request)
        .then((reponseReseau) => {
          if (reponseReseau && reponseReseau.ok) {
            const copie = reponseReseau.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copie));
          }
          return reponseReseau;
        })
        .catch(() => reponseEnCache);
      return reponseEnCache || recuperationReseau;
    })
  );
});
