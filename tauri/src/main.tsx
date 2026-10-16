import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initLang } from "./i18n";
import "./styles.css";

// Largeur REELLE d'une barre de defilement sur cette plateforme, mesuree une
// fois avant le premier rendu. Les en-tetes de colonnes (et la barre d'onglets
// des transferts) s'en servent pour reserver exactement la meme gouttiere que
// la zone qui defile en dessous, et garder les bords droits alignes.
//
// On mesurait ca avant avec un `overflow-y: scroll` factice — mais cette fausse
// barre existait pour de vrai, et certaines plateformes y dessinaient leurs
// fleches de pas : deux chevrons parasites au bout de la ligne d'en-tetes.
// Vaut 0 la ou les barres sont en surimpression (macOS), ce qui est correct :
// elles ne decalent alors rien.
function measureScrollbarWidth(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll";
  document.body.appendChild(probe);
  const w = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return w;
}
document.documentElement.style.setProperty(
  "--cp-sbw",
  `${measureScrollbarWidth()}px`,
);

// La langue est fixee AVANT le premier rendu (et transmise au backend avant
// qu'il ne nomme les lecteurs) : pas d'eclair dans la mauvaise langue.
initLang().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
