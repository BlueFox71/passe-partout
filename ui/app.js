/* Passe-Partout — noyau de l'interface : état, utilitaires, navigation entre écrans. */
(function () {
  const PP = (window.PP = { views: {}, state: {} });

  /* ---------- utilitaires texte (mêmes règles que app/textutil.py) ---------- */
  PP.esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const LIGATURES = { "œ": "oe", "Œ": "oe", "æ": "ae", "Æ": "ae", "ß": "ss" };
  PP.normalize = (s) =>
    String(s ?? "").replace(/[œŒæÆß]/g, (c) => LIGATURES[c])
      .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

  /* ---------- bibliothèque de logos (ui/logos.js, Simple Icons) ----------
     Entrée : [titre, couleur, chemin SVG 24×24 | null, [alias], populaire, sigle | null] */
  PP.logos = (() => {
    let index = null;
    const cache = new Map();
    const names = (e) => [e[0], ...e[3]];
    const build = () => {
      index = new Map();
      for (const e of window.PP_LOGOS || []) for (const n of names(e)) {
        const k = PP.normalize(n);
        if (!index.has(k)) index.set(k, e);
      }
    };
    // Couleurs officielles quand celles de Simple Icons ne rendent pas la marque reconnaissable.
    const BRAND_COLORS = {
      "McDonald's": { bg: "DA291C", ink: "FFC72C" },
      "Burger King": { bg: "D62300", ink: "F5EBDC" },
      "IKEA": { bg: "0058A3", ink: "FFDA1A" },
      "E.Leclerc": { bg: "0066B3", ink: "FFFFFF" },
      "La Poste": { bg: "FFC800", ink: "003DA5" },
    };
    const luminance = (hex) => {
      const n = parseInt(hex, 16);
      const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
    };
    return {
      // Logo dont le titre ou un alias correspond exactement au nom (casse et accents ignorés).
      find(name) {
        if (!index) build();
        return index.get(PP.normalize(name)) || null;
      },
      // Suggestions : exact, puis début du nom, puis début d'un mot, puis contenu ; marques courantes d'abord.
      suggest(query, limit = 8) {
        const q = PP.normalize(query);
        if (!q) return [];
        const out = [];
        for (const e of window.PP_LOGOS || []) {
          let best = 9;
          for (const n of names(e)) {
            const k = PP.normalize(n);
            const s = k === q ? 0 : k.startsWith(q) ? 1 : k.split(/[\s.\-&'+/]/).some((w) => w.startsWith(q)) ? 2 : q.length >= 3 && k.includes(q) ? 3 : 9;
            if (s < best) best = s;
          }
          if (best < 9) out.push([best + (e[4] ? 0 : 0.5), e]);
        }
        out.sort((a, b) => a[0] - b[0] || a[1][0].length - b[1][0].length);
        return out.slice(0, limit).map((x) => x[1]);
      },
      // Rend le logo en PNG carré 256 px (data URL) : glyphe sur la couleur de la marque.
      // Deux images se ressemblent-elles (écart moyen faible en 48×48) ? Tolère les petites
      // différences de rendu entre versions du moteur.
      async similar(a, b) {
        const pixels = (src) => new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = c.height = 48;
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0, 48, 48);
            resolve(g.getImageData(0, 0, 48, 48).data);
          };
          img.onerror = () => resolve(null);
          img.src = src;
        });
        const [pa, pb] = await Promise.all([pixels(a), pixels(b)]);
        if (!pa || !pb) return false;
        let diff = 0;
        for (let i = 0; i < pa.length; i++) diff += Math.abs(pa[i] - pb[i]);
        return diff / pa.length < 6;
      },
      // Rend le logo en PNG carré 256 px (data URL).
      // Version 2 : dessin blanc (cerné de sombre si le fond est clair), couleurs officielles pour
      // quelques marques. La version 1 (dessin noir sur fond clair) sert à reconnaître les anciens logos.
      render(e, version = 2) {
        const key = version + "|" + e[0];
        if (cache.has(key)) return cache.get(key);
        const [, hex0, path, , , letters] = e;
        const brand = version >= 2 ? BRAND_COLORS[e[0]] : null;
        const hex = brand ? brand.bg : hex0;
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const g = c.getContext("2d");
        const base = "#" + hex;
        const grad = g.createLinearGradient(0, 0, 256, 256);
        grad.addColorStop(0, base);
        grad.addColorStop(1, PP.shade(base));
        g.fillStyle = path ? base : grad;
        g.fillRect(0, 0, 256, 256);
        const light = luminance(hex) > 0.6;
        const n = parseInt(hex, 16);
        const nearWhite = (n >> 16) >= 225 && ((n >> 8) & 255) >= 225 && (n & 255) >= 225;
        let ink, outline = null;
        if (version < 2) ink = light ? "#16101f" : "#ffffff";
        else if (brand) ink = "#" + brand.ink;
        else if (light && nearWhite) ink = "#16101f";          // fond quasi blanc : dessin sombre
        else { ink = "#ffffff"; if (light) outline = "#16101f"; } // fond clair coloré : blanc cerné
        g.fillStyle = ink;
        g.lineJoin = "round";
        if (path) {
          g.translate(52, 52);
          g.scale(152 / 24, 152 / 24);
          const p2 = new Path2D(path);
          if (outline) { g.strokeStyle = outline; g.lineWidth = 1.1; g.stroke(p2); }
          g.fill(p2);
        } else {
          const t = letters || PP.initial(e[0]);
          const size = [0, 140, 112, 92, 74, 62, 54][Math.min(t.length, 6)];
          g.font = `800 ${size}px "Segoe UI", system-ui, sans-serif`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          if (outline) { g.strokeStyle = outline; g.lineWidth = 10; g.strokeText(t, 128, 136); }
          g.fillText(t, 128, 136);
        }
        const url = c.toDataURL("image/png");
        cache.set(key, url);
        return url;
      },
    };
  })();

  // '#' consomme un caractère de la valeur, le reste du modèle est inséré tel quel ;
  // le surplus de la valeur est ajouté à la suite.
  PP.applyMask = (value, mask) => {
    value = String(value ?? "");
    if (!mask) return value;
    let out = "", i = 0;
    for (const m of mask) {
      if (i >= value.length) break;
      if (m === "#") out += value[i++];
      else out += m;
    }
    return out + value.slice(i);
  };

  PP.strength = (pw) => {
    pw = String(pw ?? "");
    if (!pw) return 0;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
    const score = (pw.length >= 8 ? 1 : 0) + (pw.length >= 12 ? 1 : 0) + Math.max(0, classes - 1);
    return Math.min(4, score);
  };

  PP.search = (accounts, query) => {
    const q = PP.normalize(query);
    if (!q) return accounts;
    return accounts.filter((a) => PP.normalize(`${a.name} ${a.login} ${a.category}`).includes(q));
  };

  PP.money = (n) => (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  PP.dateFr = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
  PP.todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  PP.daysUntil = (iso) => Math.round((new Date(iso + "T00:00:00") - new Date(PP.todayIso() + "T00:00:00")) / 86400000);

  /* ---------- couleurs, logos ---------- */
  const PALETTE = ["#ff3d9a", "#7c3aed", "#00b8d9", "#f97316", "#22c55e", "#e11d48", "#6366f1", "#14b8a6", "#eab308", "#a855f7"];
  PP.PALETTE = PALETTE;
  PP.colorFor = (name) => {
    let h = 0;
    for (const c of PP.normalize(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };
  PP.initial = (name) => (String(name || "?").trim()[0] || "?").toUpperCase();
  PP.logo = (item, cls = "") => {
    const name = item.name || "?";
    if (item.image) return `<div class="logo img ${cls}"><img src="${PP.esc(item.image)}" alt=""></div>`;
    return `<div class="logo ${cls}" style="background:linear-gradient(135deg,${PP.colorFor(name)},${PP.shade(PP.colorFor(name))})">${PP.esc(PP.initial(name))}</div>`;
  };
  PP.safeColor = (c, name) => (/^#[0-9a-fA-F]{6}$/.test(c || "") ? c : PP.colorFor(name));
  PP.avatar = (p, cls = "") => {
    if (p.avatar) return `<div class="logo ${cls}"><img src="${PP.esc(p.avatar)}" alt=""></div>`;
    const c = PP.safeColor(p.color, p.name);
    return `<div class="logo ${cls}" style="background:linear-gradient(135deg,${c},${PP.shade(c)})">${PP.esc(PP.initial(p.name))}</div>`;
  };
  PP.shade = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.round(v * 0.55)).toString(16).padStart(2, "0");
    return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
  };

  /* ---------- icônes ---------- */
  const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  PP.icon = {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    star: svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>'),
    starFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    export: svg('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>'),
    gift: svg('<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M12 8S10.5 3 8 3a2.5 2.5 0 0 0 0 5h4zm0 0s1.5-5 4-5a2.5 2.5 0 0 1 0 5h-4z"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
    grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    tag: svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
    check: svg('<path d="m5 12 5 5L20 7"/>'),
    image: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'),
    users: svg('<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>'),
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    select: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>'),
  };

  // Logo de la marque : clé blanche dans un cadre au contour néon rose → violet (même dessin que assets/icon.svg).
  let brandSeq = 0;
  PP.brandSvg = () => {
    const id = "pg" + brandSeq++;
    return `<svg viewBox="0 0 64 64"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="4" y1="4" x2="60" y2="60"><stop offset="0" stop-color="#ff3d9a"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
      <rect x="5" y="5" width="54" height="54" rx="15" fill="#140a26"/>
      <rect x="5" y="5" width="54" height="54" rx="15" fill="none" stroke="url(#${id})" stroke-width="3.5"/>
      <g transform="rotate(45 32 32)" fill="#fff">
        <path fill-rule="evenodd" d="M18 21a11 11 0 1 1 0 22a11 11 0 0 1 0-22zm0 7a4 4 0 1 0 0 8a4 4 0 0 0 0-8z"/>
        <rect x="27.5" y="29" width="25" height="6" rx="2"/>
        <rect x="41" y="33.5" width="4.5" height="8" rx="1.4"/><rect x="47.5" y="33.5" width="4.5" height="5.5" rx="1.4"/>
      </g></svg>`;
  };
  PP.brand = (cls = "") => `<div class="brand ${cls}">${PP.brandSvg()}<span>Passe-Partout</span></div>`;

  /* ---------- toasts et modales ---------- */
  PP.toast = (msg, { error = false, seconds = 2.6, bar = 0 } = {}) => {
    const el = document.createElement("div");
    el.className = "toast" + (error ? " error" : "");
    el.innerHTML = `<div><div>${PP.esc(msg)}</div>${bar ? '<div class="bar" style="width:100%"></div>' : ""}</div>`;
    document.getElementById("toasts").appendChild(el);
    if (bar) {
      const b = el.querySelector(".bar");
      b.animate([{ width: "100%" }, { width: "0%" }], { duration: bar * 1000, easing: "linear" });
      seconds = Math.min(seconds, bar);
    }
    setTimeout(() => el.remove(), seconds * 1000);
  };

  PP.modal = {
    open(html, { cls = "", onClose } = {}) {
      PP.modal.close();
      const root = document.getElementById("modal-root");
      root.innerHTML = `<div class="overlay"><div class="modal ${cls}">${html}</div></div>`;
      const ov = root.firstElementChild;
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) PP.modal.close(); });
      PP.modal._onClose = onClose;
      return ov.firstElementChild;
    },
    close() {
      const root = document.getElementById("modal-root");
      if (!root.firstElementChild) return;
      root.innerHTML = "";
      const cb = PP.modal._onClose;
      PP.modal._onClose = null;
      if (cb) cb();
    },
    isOpen: () => !!document.getElementById("modal-root").firstElementChild,
  };

  PP.confirm = (title, text, { ok = "Confirmer", danger = false } = {}) =>
    new Promise((resolve) => {
      let done = false;
      const m = PP.modal.open(
        `<h2>${PP.esc(title)}</h2><p style="color:var(--muted);margin:0">${PP.esc(text)}</p>
         <div class="modal-foot"><button class="btn btn-ghost" data-r="0">Annuler</button>
         <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-r="1">${PP.esc(ok)}</button></div>`,
        { cls: "sm", onClose: () => { if (!done) resolve(false); } }
      );
      m.querySelectorAll("[data-r]").forEach((b) =>
        b.addEventListener("click", () => { done = true; PP.modal.close(); resolve(b.dataset.r === "1"); })
      );
    });

  /* ---------- presse-papiers ---------- */
  PP.copySecret = async (text, what = "Mot de passe") => {
    await PP.call("copy_secret", text);
    PP.toast(`${what} copié — effacé du presse-papiers dans 30 s`, { bar: 30, seconds: 3 });
  };
  PP.copyPlain = async (text, what = "Identifiant") => {
    await PP.call("copy_plain", text);
    PP.toast(`${what} copié`);
  };

  /* ---------- accès à l'API (pywebview ou maquette) ---------- */
  PP.call = async (name, ...args) => {
    try {
      return await PP.api[name](...args);
    } catch (e) {
      const msg = (e && (e.message || e.toString())) || "Erreur inconnue";
      if (/verrouill/i.test(msg)) { PP.onLocked(); throw e; }
      PP.toast(msg.replace(/^Error:\s*/, ""), { error: true, seconds: 4 });
      throw e;
    }
  };

  // Sous pywebview, l'API arrive avec l'événement « pywebviewready ». La maquette n'est utilisée
  // que si aucune trace de pywebview n'apparaît (interface ouverte dans un navigateur).
  function waitForApi() {
    return new Promise((resolve) => {
      if (window.pywebview && window.pywebview.api) return resolve(window.pywebview.api);
      let settled = false;
      const done = (api) => { if (!settled) { settled = true; resolve(api); } };
      window.addEventListener("pywebviewready", () => done(window.pywebview.api));
      const check = () => {
        if (settled) return;
        if (window.pywebview) return setTimeout(check, 200); // pywebview présent mais pas encore prêt
        done(window.MockApi);
        document.body.insertAdjacentHTML("beforeend",
          '<div style="position:fixed;right:10px;bottom:10px;z-index:99;padding:4px 10px;border-radius:8px;background:#ffc23d;color:#1a0b2e;font-weight:700;font-size:12px">MAQUETTE — données fictives</div>');
      };
      setTimeout(check, 600);
    });
  }

  /* ---------- navigation ---------- */
  PP.render = (html) => {
    document.getElementById("app").innerHTML = html;
    return document.getElementById("app");
  };

  PP.refreshState = async () => {
    const s = await PP.call("get_state");
    Object.assign(PP.state, s);
    return s;
  };

  PP.route = async () => {
    PP.modal.close();
    const s = await PP.refreshState();
    if (s.locked || s.corrupt) return PP.views.lock.show();
    if (!s.has_data) return PP.views.profiles.welcome();
    PP.state.settings = await PP.call("get_settings");
    if (PP.state.profileId === undefined) {
      if (s.profiles.length === 1) PP.state.profileId = s.profiles[0].id;
      else return PP.views.profiles.show();
    }
    return PP.views.main.show();
  };

  PP.chooseProfile = (id) => {
    PP.state.profileId = id; // null = « Tout le monde »
    PP.state.filter = "all";
    PP.state.selectedId = null;
    PP.state.query = "";
    PP.views.main.show();
  };

  PP.onLocked = () => {
    PP.modal.close();
    if (PP.views.main) PP.views.main.clear();
    PP.state.profiles = [];
    PP.state.locked = true;
    PP.views.lock.show();
  };

  PP.lockNow = async () => {
    await PP.call("lock");
    PP.onLocked();
  };
  window.app = { onLocked: PP.onLocked }; // appelé par Python (verrouillage de session Windows)

  /* ---------- verrouillage automatique sur inactivité ---------- */
  let lastActivity = Date.now();
  ["mousemove", "mousedown", "keydown", "wheel"].forEach((ev) =>
    window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true })
  );
  setInterval(() => {
    const st = PP.state;
    const mins = st.settings && st.settings.autolock_minutes;
    if (!mins || st.locked || st.lock_mode === "none" || !st.has_data) return;
    if (Date.now() - lastActivity > mins * 60000) PP.lockNow();
  }, 5000);

  /* ---------- raccourcis clavier ---------- */
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && PP.modal.isOpen()) { PP.modal.close(); return; }
    const main = PP.views.main;
    if (!main || !main.active()) return;
    if (e.ctrlKey && e.key.toLowerCase() === "f") { e.preventDefault(); main.focusSearch(); }
    if (e.ctrlKey && e.key.toLowerCase() === "n" && !PP.modal.isOpen()) { e.preventDefault(); main.newItem(); }
  });

  PP.start = async () => {
    PP.api = await waitForApi();
    PP.state.filter = "all";
    PP.state.query = "";
    await PP.route();
  };
})();
