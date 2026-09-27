// Page d'accueil (ecran de depot de fichier, avant toute analyse) : liste
// des fonctions de l'outil pour une collegue non technique, et indicateur de
// version en pied de page (constante VERSION_OUTIL, js/app.js).
const { test, expect } = require("@playwright/test");

test("page d'accueil : presentation des fonctions et numero de version visibles", async ({ page }) => {
  await page.goto("/index.html");

  const presentation = page.locator("#panelPresentation");
  await expect(presentation).toBeVisible();
  await expect(presentation.locator("li")).not.toHaveCount(0);
  await expect(presentation).toContainText("spectrogramme");
  await expect(presentation).toContainText("Vol");

  const version = page.locator("#pieDeVersion");
  await expect(version).toBeVisible();
  await expect(version).toHaveText(/^v\d+\.\d+\s*—/);
});
