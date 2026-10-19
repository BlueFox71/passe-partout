/* Téléphone — saisie d'un code partagée par l'écran de verrouillage et la synchro : pavé PIN (points,
   validation automatique quand la longueur est connue) ou champ mot de passe, et un seul écouteur clavier
   pour l'aperçu sur ordinateur (un écouteur par vue compterait chaque touche deux fois).
   PP.pinPad.markup({pin, placeholder, button}) → HTML ;
   PP.pinPad.bind(el, {pinLength, onSubmit(value), blocked()}) → {clear({field})} : branche la saisie affichée
   dans `el` ; clear vide le pavé, et aussi le champ mot de passe (puis le focus) sauf avec field: false. */
(function () {
  let active = null; // {dots, press} du pavé affiché, sinon null

  window.addEventListener("keydown", (e) => {
    if (!active || !active.dots.isConnected) return;
    if (/^[0-9]$/.test(e.key)) active.press(e.key);
    else if (e.key === "Backspace") active.press("del");
    else if (e.key === "Enter") { e.preventDefault(); active.press("ok"); }
  });

  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join("");

  function markup({ pin, placeholder = "", button = "Valider" }) {
    return pin
      ? `<div class="pin-dots" id="dots"></div>
         <div class="pin-pad m-pad">${keys}
           <button type="button" data-k="del" aria-label="Effacer">⌫</button><button type="button" data-k="0">0</button>
           <button type="button" data-k="ok" aria-label="Valider" class="m-ok">✓</button></div>`
      : `<input id="pw" class="input m-pw" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
           placeholder="${PP.esc(placeholder)}">
         <button type="button" class="btn btn-primary m-wide" id="go">${PP.esc(button)}</button>`;
  }

  // `blocked()` vrai : vérification ou délai en cours, saisie ignorée. Longueur inconnue (0) : validation par ✓.
  function bind(el, { pinLength = 0, onSubmit, blocked = () => false }) {
    const dots = el.querySelector("#dots");
    if (!dots) {
      const pw = el.querySelector("#pw");
      const send = () => { if (!blocked()) onSubmit(pw.value); };
      pw.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
      el.querySelector("#go").addEventListener("click", send);
      return { clear: ({ field = true } = {}) => { if (field) { pw.value = ""; pw.focus(); } } };
    }
    let code = "";
    const draw = () => {
      // longueur inconnue : seulement les chiffres tapés (pas de cases vides qui suggéreraient une longueur)
      const n = pinLength || code.length;
      dots.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < code.length ? "f" : ""}"></i>`).join("");
    };
    const press = (k) => {
      if (blocked()) return;
      if (k === "del") code = code.slice(0, -1);
      else if (k === "ok") return onSubmit(code);
      else if (code.length < (pinLength || 12)) code += k;
      draw();
      if (pinLength && code.length === pinLength) onSubmit(code);
    };
    el.querySelectorAll("[data-k]").forEach((b) => {
      b.tabIndex = -1;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // pas de focus : Entrée ne « reclique » pas
      b.addEventListener("click", () => press(b.dataset.k));
    });
    draw();
    active = { dots, press };
    return { clear: () => { code = ""; draw(); } };
  }

  PP.pinPad = { markup, bind, release: () => { active = null; } };
})();
