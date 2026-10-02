"use strict";
/* =========================================================================
   Service worker de la telecommande phyphox.

   Role unique : garder une copie locale de la page et de ses quelques
   fichiers, pour qu'elle se rouvre depuis l'icone de l'ecran d'accueil meme
   sans acces internet.

   Portee : ce fichier est servi depuis le dossier telecommande/, sa portee
   est donc limitee a ce dossier ; il ne touche jamais aux pages de l'outil
   d'analyse acoustique.

   IMPORTANT (v2) : la page dialogue desormais directement avec les
   esclaves phyphox (fetch vers http://192.168.x.x:8080/...). Ces requetes
   passeraient par ce service worker si on ne les excluait pas, et une
   reponse mise en cache (par exemple a /control?cmd=start) pourrait etre
   renvoyee sans que la commande atteigne jamais l'esclave. Seules les
   requetes vers le site de la page elle-meme sont donc traitees ici ;
   toutes les autres partent directement sur le reseau, sans cache.
*/

// A incrementer a chaque modification de la page.
const CACHE_NAME = "telecommande-phyphox-2.0";

const FICHIERS_A_METTRE_EN_CACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // "reload" : contourne le cache HTTP du navigateur, pour mettre en
      // cache la version reellement en ligne et pas une copie perimee.
      cache.addAll(FICHIERS_A_METTRE_EN_CACHE.map((u) => new Request(u, { cache: "reload" })))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(noms.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Cache d'abord (fiabilite hors ligne), avec mise a jour silencieuse du
// cache en arriere-plan des que le reseau repond.
self.addEventListener("fetch", (event) => {
  const requete = event.request;
  if (requete.method !== "GET") return;
  if (new URL(requete.url).origin !== self.location.origin) return; // esclaves phyphox : jamais intercepte

  event.respondWith(
    caches.match(requete, { ignoreSearch: true }).then((reponseEnCache) => {
      const recuperationReseau = fetch(requete)
        .then((reponseReseau) => {
          if (reponseReseau && reponseReseau.ok) {
            const copie = reponseReseau.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(requete, copie));
          }
          return reponseReseau;
        })
        .catch(() => reponseEnCache);
      return reponseEnCache || recuperationReseau;
    })
  );
});
