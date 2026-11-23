// Appli de terrain – vérification des repères IGN du lot 2 (Montpellier Méditerranée Métropole)
(function () {
  const S = window.Stockage;
  const REPERES = window.REPERES;
  const PAR_ID = Object.fromEntries(REPERES.map(r => [r.id, r]));
  // Extraits des fiches IGN (générés sur le PC par extraire-photos-ign.ps1 et extraire-textes-ign) :
  // repères qui ont une photo sur leur fiche, et support / partie support / repèrements des NGF
  const PHOTOS_IGN = new Set(window.PHOTOS_IGN || []);
  const FICHES_ABSENTES = new Set(window.FICHES_ABSENTES || []);   // fiche PDF retirée du site IGN
  const FICHES_IGN = window.FICHES_IGN || {};
  const apos = (s) => String(s || '').replace(/[’‘`´]/g, "'");   // apostrophes typographiques ≡ droites
  const ETATS = [
    ['bon', 'Bon état'],
    ['endommage', 'Endommagé'],
    ['deplace', 'Présumé déplacé'],
    ['detruit', 'Détruit'],
    ['introuvable', 'Introuvable'],
    ['inaccessible', 'Inaccessible (propriété privée, travaux…)']
  ];
  const ETAT_LIB = Object.fromEntries(ETATS);
  // Infos de terrain en un geste (boutons à choix unique ; retoucher le bouton choisi l'annule)
  const CHAMPS = [
    { cle: 'ciel', titre: 'Ciel pour le GNSS', choix: [['degage', 'Dégagé'], ['partiel', 'Masques partiels'], ['masque', 'Masqué']] },
    // « Clé / gardien » a été fusionné dans « Privé / Non accessible » : une ancienne valeur 'cle' s'affiche comme 'prive'
    { cle: 'acces', titre: 'Accès', choix: [['libre', 'Libre'], ['prive', 'Privé / Non accessible'], ['dangereux', 'Circulation dangereuse']], alias: { cle: 'prive' } },
    { cle: 'conforme', titre: 'Conforme à la description IGN', choix: [['oui', 'Oui'], ['non', 'Non']] },
    // « Démolition / aménagement » a été fusionné dans « Chantier (actuel ou à venir) »
    { cle: 'menace', titre: 'Menace à proximité', choix: [['aucune', 'Aucune'], ['chantier', 'Chantier (actuel ou à venir)']], alias: { demolition: 'chantier' } }
  ];
  const libChamp = (c, v) => ((c.choix.find(x => x[0] === v) || [])[1]) || '';
  // Photos exigées pour terminer la visite : de près et de loin, dans tous les cas. Même si le repère est
  // introuvable, détruit ou inaccessible (l'emplacement attendu et l'environnement) : c'est la preuve pour le
  // client qu'on est allé sur place.
  const photosRequises = () => ['pres', 'loin'];
  // Photos attendues pour la fiche de visite : une de près, une de loin, puis autant d'« autres » que voulu.
  const ROLES = { pres: 'Photo de près', loin: 'Photo de loin', autre: 'Autre photo' };
  const TERMINEES = { afficher: 'Visites terminées : affichées', masquer: 'Visites terminées : masquées', seules: 'Visites terminées seulement' };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let visites = {};          // id -> visite (données partagées)
  let ouvert = null;         // id du repère affiché dans la fiche
  let maPos = null;          // {lat, lon, acc}
  const filtre = { RBF: true, NGF: true, terminees: localStorage.getItem('calque-terminees') || 'afficher' };
  let map, marqueurs = {}, coucheMoi = null, cercleMoi = null, suivi = false, desabonner = null;

  // ---------------- Thème clair / sombre ----------------
  // auto = suit le réglage du téléphone ; sinon choix forcé dans le menu.
  const mqSombre = window.matchMedia('(prefers-color-scheme: dark)');
  function appliquerTheme() {
    const pref = localStorage.getItem('theme') || 'auto';
    const sombre = pref === 'sombre' || (pref === 'auto' && mqSombre.matches);
    document.documentElement.dataset.theme = sombre ? 'dark' : 'light';
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = sombre ? '#0f141b' : '#1f4e79';
  }
  appliquerTheme();
  if (mqSombre.addEventListener) mqSombre.addEventListener('change', appliquerTheme);

  // ---------------- Démarrage ----------------
  S.init();
  // Écran d'accueil : le prénom (affiché sur les visites et le journal)
  // + en ligne, le code équipe (mot de passe du compte partagé COMPTE_EQUIPE).
  {
    const em = $('#cx-email'), mdp = $('#cx-mdp');
    em.type = 'text'; em.autocomplete = 'given-name'; em.placeholder = 'ex. Jack';
    em.value = localStorage.getItem('nom-terrain') || '';
    em.closest('label').firstChild.textContent = 'Ton prénom';
    if (S.demo) { mdp.required = false; mdp.closest('label').hidden = true; $('#mode-demo').hidden = false; }
    else mdp.closest('label').firstChild.textContent = 'Code équipe (donné par le bureau)';
    $('#form-connexion button').textContent = S.demo ? 'Commencer' : 'Se connecter';
  }
  S.onMigre = (n) => toast(`${n} repère(s) relevé(s) en mode local envoyé(s) à toute l'équipe`);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  S.onAuth(u => {
    $('#ecran-connexion').hidden = !!u;
    $('#ecran-app').hidden = !u;
    if (u) demarrerApp(); else if (desabonner) { desabonner(); desabonner = null; }
  });

  $('#form-connexion').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#cx-erreur').textContent = '';
    const prenom = $('#cx-email').value.trim();
    if (!prenom) { $('#cx-erreur').textContent = 'Indique ton prénom.'; return; }
    localStorage.setItem('nom-terrain', prenom);
    try { await S.connexion(S.demo ? prenom : window.COMPTE_EQUIPE, $('#cx-mdp').value); }
    catch (err) { $('#cx-erreur').textContent = messageErreur(err); }
  });

  function messageErreur(err) {
    const c = (err && err.code) || '';
    if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found') || c.includes('invalid-login')) return 'Code équipe incorrect.';
    if (c.includes('network')) return 'Pas de réseau. Réessayez.';
    if (c.includes('too-many-requests')) return 'Trop de tentatives, patientez une minute.';
    return (err && err.message) || 'Erreur inconnue';
  }

  let appDemarree = false;
  function demarrerApp() {
    if (S.demo) $('#btn-deconnexion').textContent = 'Changer de prénom';
    $('#menu-user').textContent = S.demo ? 'Mode local (relevés gardés sur ce téléphone)' : 'En ligne : relevés partagés en direct avec toute l\'équipe';
    $('#menu-nom').value = localStorage.getItem('nom-terrain') || '';
    if (!appDemarree) { initCarte(); initUI(); appDemarree = true; }
    desabonner = S.ecouter((v) => { visites = v || {}; rafraichir(); });
    majEnvoi();
    S.onFileChange = () => { majEnvoi(); if (ouvert) afficherFiche(ouvert, true); };
    ajusterBandeau();
  }

  // Bandeau : nom complet de la Métropole s'il tient à côté du logo, sinon « 3M » (téléphone en gros caractères)
  function ajusterBandeau() {
    const el = $('#bandeau-3m'); if (!el) return;
    el.textContent = 'Montpellier Méditerranée Métropole';
    const bandeau = $('#bandeau'), logo = bandeau.querySelector('img'), t = el.parentElement.getBoundingClientRect();
    if (!t.width) return;   // bandeau pas encore affiché
    if (t.left < logo.getBoundingClientRect().right + 8 || t.right > bandeau.getBoundingClientRect().right - 8) el.textContent = '3M';
  }
  window.addEventListener('resize', ajusterBandeau);
  $('#bandeau img').addEventListener('load', ajusterBandeau);

  // ---------------- Carte ----------------
  function initCarte() {
    map = L.map('carte', { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    const wmts = (layer, fmt) => L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer +
      '&STYLE=normal&FORMAT=' + fmt + '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', { maxZoom: 20, maxNativeZoom: 19, attribution: '© IGN' });
    const fonds = {
      plan: wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'),
      ortho: wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'),
      osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' })
    };
    let fond = localStorage.getItem('fond') || 'plan';
    let actif = fonds[fond].addTo(map);
    $('#carte').dataset.fond = fond;   // en mode sombre, les fonds « plan » sont assombris (pas la photo aérienne)
    $('#sel-fond').value = fond;
    $('#sel-fond').onchange = (e) => { map.removeLayer(actif); fond = e.target.value; actif = fonds[fond].addTo(map); actif.bringToBack(); localStorage.setItem('fond', fond); $('#carte').dataset.fond = fond; };

    // Contours des communes du lot 2
    const communes = L.geoJSON({
      type: 'FeatureCollection',
      features: (window.COMMUNES_LOT2 || []).map(c => ({ type: 'Feature', properties: { nom: c.nom }, geometry: { type: 'MultiPolygon', coordinates: c.poly } }))
    }, { style: { color: '#1f4e79', weight: 2, fill: true, fillOpacity: 0.04, dashArray: '6 4' }, interactive: false }).addTo(map);
    const b = communes.getBounds();
    const cadrer = () => { map.invalidateSize(); if (b.isValid()) map.fitBounds(b, { padding: [10, 10] }); else map.setView([43.57, 3.8], 12); };
    cadrer(); setTimeout(cadrer, 300);
    window.addEventListener('resize', () => map.invalidateSize());

    REPERES.forEach(r => {
      const m = L.marker([r.lat, r.lon], { icon: icone(r, null), keyboard: false });
      m.on('click', () => afficherFiche(r.id));
      marqueurs[r.id] = m;
    });

    // Position GPS en continu
    if ('geolocation' in navigator) {
      navigator.geolocation.watchPosition(p => {
        maPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: new Date(p.timestamp || Date.now()).toISOString() };
        const ll = [maPos.lat, maPos.lon];
        if (!coucheMoi) {
          cercleMoi = L.circle(ll, { radius: maPos.acc, color: '#1a73e8', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
          coucheMoi = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(map);
        } else { coucheMoi.setLatLng(ll); cercleMoi.setLatLng(ll).setRadius(maPos.acc); }
        if (suivi) map.panTo(ll);
        if (ouvert) majDistanceFiche();
        if (!$('#liste').hidden) remplirListe();
      }, err => console.warn('GPS', err), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    }
    map.on('dragstart', () => { suivi = false; $('#btn-moi').classList.remove('actif'); });
  }

  function statutVisuel(v) {
    // Deux statuts seulement : à faire / visite terminée (l'état constaté, même « introuvable », n'y change rien).
    // Les anciennes réservations (fonction retirée) comptent comme « à faire ».
    return v && v.statut === 'fait' ? 'fait' : 'afaire';
  }

  function icone(r, v) {
    const sv = statutVisuel(v);
    // Repère « non retrouvé » (ou en mauvais état) d'après l'IGN : même pointeur, avec un point blanc au centre
    // Repère dont la fiche n'existe plus sur le site IGN : pointeur blanc tant qu'il est à faire (vert une fois visité)
    const sansFiche = FICHES_ABSENTES.has(r.id) && sv === 'afaire';
    const nonRetrouveIGN = r.e && r.e !== 'Bon état' && !sansFiche;
    const forme = r.t === 'RBF' ? 'tri' : 'rond';
    return L.divIcon({
      className: 'mq', iconSize: [26, 26], iconAnchor: [13, 13],
      html: `<div class="mq-${forme} s-${sansFiche ? 'sansfiche' : sv}"></div>${nonRetrouveIGN ? `<i class="point-ign point-${forme}"></i>` : ''}`
    });
  }

  function visible(r) {
    if (!filtre[r.t]) return false;
    const terminee = !!(visites[r.id] && visites[r.id].statut === 'fait');
    if (filtre.terminees === 'masquer' && terminee) return false;
    if (filtre.terminees === 'seules' && !terminee) return false;
    return true;
  }

  function rafraichir() {
    REPERES.forEach(r => {
      const m = marqueurs[r.id];
      m.setIcon(icone(r, visites[r.id]));
      if (visible(r)) { if (!map.hasLayer(m)) m.addTo(map); } else if (map.hasLayer(m)) map.removeLayer(m);
    });
    // Progression (sur les types affichés)
    const cibles = REPERES.filter(r => filtre[r.t]);
    const faits = cibles.filter(r => visites[r.id] && visites[r.id].statut === 'fait').length;
    $('#prog-texte').textContent = `${faits} / ${cibles.length} visités`;
    $('#prog-rempli').style.width = (cibles.length ? 100 * faits / cibles.length : 0) + '%';
    if (ouvert) afficherFiche(ouvert, true);
    if (!$('#liste').hidden) remplirListe();
  }

  // ---------------- Distances ----------------
  function distance(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function cap(a, b) {
    const rad = Math.PI / 180;
    const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
    const deg = (Math.atan2(y, x) / rad + 360) % 360;
    return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8];
  }
  const fmtDist = (d) => d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(d < 10000 ? 2 : 1).replace('.', ',') + ' km';
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  // ---------------- Fiche repère ----------------
  async function afficherFiche(id, rafraichissement) {
    const r = PAR_ID[id]; if (!r) return;
    // Ne pas écraser une saisie en cours lors d'un rafraîchissement en direct
    if (rafraichissement && ouvert === id) {
      const actifEl = document.activeElement;
      if (actifEl && $('#fiche').contains(actifEl) && (actifEl.tagName === 'TEXTAREA' || actifEl.tagName === 'SELECT')) return;
    }
    ouvert = id;
    const v = visites[id] || {};
    const sv = statutVisuel(visites[id]);
    const photos = (v.photos || []);
    // Les photos sont sur le téléphone qui les a prises : on affiche celles présentes ici
    const urls = {};
    for (const p of photos) if (p.cle) {
      urls[p.cle] = await S.urlPhoto(p.cle);
      const pt = (v.pointages || {})[p.cle];
      if (urls[p.cle] && pt) try { urls[p.cle] = await urlMarquee(urls[p.cle], pt); } catch (e) { }
    }
    if (ouvert !== id) return;   // une autre fiche a été ouverte entre-temps
    const ficheIgn = FICHES_IGN[id];   // support / partie support / repèrements relevés sur la fiche IGN (NGF)
    const precisionPos = r.t === 'NGF' ? 'Position IGN approchée (~10 m) : cherchez l\'édifice décrit.' : '';

    const libStatut = {
      afaire: 'À faire',
      fait: `Visite terminée par ${esc(v.visitePar || '?')} le ${fmtDate(v.visiteLe)}`    }[sv];

    // Photos rangées par rôle (près / loin / autres). Les anciennes photos sans rôle comptent comme « autre ».
    const indexees = photos.map((p, i) => Object.assign({ i }, p));
    const parRole = (role) => indexees.filter(p => (p.role || 'autre') === role);
    const vignette = (p) => urls[p.cle]
      ? `<figure><img src="${urls[p.cle]}" data-i="${p.i}" alt=""><figcaption>${(v.pointages || {})[p.cle] ? '📍 ' : ''}${p.gps && distance(p.gps, r) > ECART_ALERTE ? `⚠️ prise à ${fmtDist(distance(p.gps, r))} · ` : ''}${esc(p.auteur || '')} · ${fmtDate(p.date)}</figcaption></figure>`
      : `<figure class="ailleurs" data-i="${p.i}"><div class="photo-absente">📱<br>sur le téléphone de ${esc(p.auteur || '?')}</div><figcaption>${fmtDate(p.date)}</figcaption></figure>`;
    const emplacement = (role) => {
      const ph = parRole(role).slice(-1)[0];
      const contenu = ph ? vignette(ph) : '';
      return `<div class="emplacement ${contenu ? 'rempli' : ''}" data-role="${role}">
        <div class="empl-titre">${ROLES[role]} ${contenu ? '✔' : ''}</div>
        ${contenu}
        <button class="photo-ajout" data-role="${role}">📷 ${contenu ? 'Reprendre' : 'Ajouter'}</button>
      </div>`;
    };
    const terminee = v.statut === 'fait';

    $('#fiche-contenu').innerHTML = `
      <div class="fiche-tete">
        <span class="badge ${r.t}">${r.t === 'RBF' ? '▲ Géodésique RBF (X/Y)' : '● Nivellement NGF (Z)'}</span>
        <h2>${esc(r.n)}</h2>
        <div class="commune">${esc(r.c)} · <span id="fiche-dist"></span></div>
        <div class="statut s-${sv}">${libStatut}</div>
      </div>
      <div class="actions">
        ${FICHES_ABSENTES.has(r.id) ? '<div class="btn fiche-absente">📄 Fiche absente du site IGN</div>' : `<a class="btn fiche-ign" href="${esc(r.u)}" target="_blank" rel="noopener">📄 Fiche IGN originale</a>`}
      </div>
      <div class="actions">
        <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}&travelmode=driving" target="_blank" rel="noopener"><svg width="18" height="24" viewBox="0 0 24 32" aria-hidden="true"><path d="M12 0C5.4 0 0 5.3 0 11.9 0 20.8 12 32 12 32s12-11.2 12-20.1C24 5.3 18.6 0 12 0z" fill="#ea4335"/><circle cx="12" cy="11.8" r="4.6" fill="#a50e0e"/></svg> Itinéraire</a>      </div>
      <details class="ign">
        <summary>Données IGN</summary>
        ${PHOTOS_IGN.has(r.id) ? `<img class="photo-ign" src="data/photos-ign/${r.id}.jpg" loading="lazy" alt="Photo du repère (fiche IGN)">` : '<p class="petit">Pas de photo sur la fiche IGN.</p>'}
        <p class="pre">${esc(r.l)}</p>
        ${ficheIgn ? `<dl class="ign-fiche">${[['Support', ficheIgn.s && !apos(r.l).includes(apos(ficheIgn.s)) ? ficheIgn.s : ''], ['Partie support', ficheIgn.p], ['Repèrements', ficheIgn.r]].filter(x => x[1]).map(([t, x]) => `<dt>${t}</dt><dd>${esc(x)}</dd>`).join('')}</dl>` : ''}
        <p>État IGN : <b class="${r.e !== 'Bon état' ? 'alerte' : ''}">${esc(r.e)}</b></p>
        <p class="petit">${precisionPos} WGS84 : ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}</p>
      </details>

      <h3>Photos de la visite <span id="photos-a-prendre"></span></h3>
      <div class="emplacements">${emplacement('pres')}${emplacement('loin')}</div>
      <div class="photos">
        ${parRole('autre').map(vignette).join('')}
        <button class="photo-ajout" data-role="autre">📷<br>Autre photo</button>
      </div>

      <h3>État du repère <span id="a-remplir"></span></h3>
      <label class="champ-etat">État constaté
        <select id="f-etat">
          <option value="">— choisir —</option>
          ${ETATS.map(([k, l]) => `<option value="${k}" ${v.etat === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      ${CHAMPS.map(c => `<div class="champ"><div class="champ-titre">${c.titre}</div><div class="choix" data-champ="${c.cle}">${
        c.choix.map(([k, l]) => `<button type="button" class="choix-btn ${((c.alias || {})[v[c.cle]] || v[c.cle]) === k ? 'actif' : ''}" data-val="${k}">${l}</button>`).join('')}</div></div>`).join('')}
      <label>Commentaire (repris sur la fiche de visite)
        <textarea id="f-comm" rows="3" placeholder="État du repère, accès, environnement…">${esc(v.commentaire || '')}</textarea>
      </label>

      <label class="case-terminee ${terminee ? 'cochee' : ''}">
        <input type="checkbox" id="f-terminee" ${terminee ? 'checked' : ''}>
        <span>Visite terminée</span>
      </label>
      <div id="f-archives"></div>
      ${(v.journal || []).length ? `<details class="historique"><summary>Journal des modifications (${v.journal.length})</summary><ul>${[...v.journal].reverse().map(h =>
        `<li>${fmtDate(h.le)} · <b>${esc(h.par || '?')}</b> · ${esc(h.action)}${h.ecart != null ? ` <span class="${h.ecart > ECART_ALERTE ? 'alerte' : ''}">(à ${fmtDist(h.ecart)} du repère)</span>` : ''}</li>`).join('')}</ul></details>` : ''}
      ${v.maj ? `<p class="petit">Dernière modification : ${esc(v.majPar || '')} – ${fmtDate(v.maj)}</p>` : ''}
    `;
    $('#fiche').hidden = false;
    $('#liste').hidden = true;
    majDistanceFiche();

    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    document.querySelectorAll('#fiche .photo-ajout').forEach(b => b.onclick = () => {
      const inp = $('#input-photo');
      inp.dataset.id = id; inp.dataset.role = b.dataset.role;
      inp.multiple = b.dataset.role === 'autre';
      inp.click();
    });
    document.querySelectorAll('#fiche img[data-i], #fiche .ailleurs[data-i]').forEach(el => el.onclick = () => voirPhoto(id, +el.dataset.i));
    // Enregistrement automatique de l'état et du commentaire
    $('#f-etat').onchange = () => { majARemplir(); S.maj(id, { etat: $('#f-etat').value }, 'État : ' + (ETAT_LIB[$('#f-etat').value] || '—') + (v.etat ? ' (avant : ' + (ETAT_LIB[v.etat] || v.etat) + ')' : '')); };
    document.querySelectorAll('#fiche .choix').forEach(g => g.querySelectorAll('.choix-btn').forEach(b => b.onclick = () => {
      const c = CHAMPS.find(x => x.cle === g.dataset.champ);
      const nouveau = b.classList.contains('actif') ? null : b.dataset.val;
      g.querySelectorAll('.choix-btn').forEach(x => x.classList.toggle('actif', x === b && !!nouveau));
      majARemplir();
      if (nouveau) S.maj(id, { [c.cle]: nouveau }, c.titre + ' : ' + libChamp(c, nouveau));
      else S.effacerChamps(id, [c.cle], c.titre + ' : effacé');
    }));
    $('#f-comm').onblur = () => {
      const c = $('#f-comm').value.trim();
      if (c !== (v.commentaire || '')) S.maj(id, { commentaire: c }, 'Commentaire : « ' + (c.length > 80 ? c.slice(0, 80) + '…' : c) + ' »');
    };
    $('#f-terminee').onchange = (e) => e.target.checked ? terminer(id, e.target) : rouvrir(id, e.target);
    majARemplir();
    afficherArchives(id, !rafraichissement);
  }

  // Points de l'état du repère encore vides : surlignés, et comptés à côté du titre
  function majARemplir() {
    const etat = $('#f-etat'); if (!etat) return;
    let n = 0;
    const marquer = (el, vide) => { el.classList.toggle('vide', vide); el.classList.toggle('rempli', !vide); if (vide) n++; };
    marquer($('#fiche .champ-etat'), !etat.value);
    document.querySelectorAll('#fiche .choix').forEach(g => marquer(g.closest('.champ'), !g.querySelector('.choix-btn.actif')));
    const b = $('#a-remplir');
    b.className = n ? 'a-remplir' : 'a-remplir complet';
    b.textContent = n ? `${n} point${n > 1 ? 's' : ''} à remplir` : '✔ complet';
    // Photos exigées (de près / de loin) : orange tant qu'elles manquent ; « Autre photo » reste bleu, elle est facultative.
    const requises = photosRequises(etat.value);
    let p = 0;
    document.querySelectorAll('#fiche .emplacement').forEach(e => {
      const manque = requises.includes(e.dataset.role) && !e.classList.contains('rempli');
      e.classList.toggle('manque', manque); if (manque) p++;
    });
    const bp = $('#photos-a-prendre');
    if (bp) {
      const prises = document.querySelectorAll('#fiche .emplacement.rempli').length;
      bp.className = p ? 'a-remplir' : (prises ? 'a-remplir complet' : '');
      bp.textContent = p ? `${p} photo${p > 1 ? 's' : ''} à prendre` : (prises ? '✔ complet' : '');
    }
  }

  // Visites terminées archivées pour ce repère (la plus récente en premier).
  // Lues à l'ouverture de la fiche seulement (pas à chaque mise à jour en direct) pour économiser les lectures.
  const cacheArchives = {};
  async function afficherArchives(id, relire) {
    if (relire || !(id in cacheArchives)) cacheArchives[id] = await S.archivesDe(id);
    const liste = cacheArchives[id];
    const el = $('#f-archives'); if (!el || ouvert !== id) return;
    if (liste === null) { el.innerHTML = '<p class="petit">Visites archivées : consultables avec du réseau.</p>'; return; }
    if (!liste.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<details class="historique archives"><summary>Visites terminées archivées (${liste.length})</summary><ul>${liste.map((a, k) =>
      `<li>${k === 0 ? '<b>Dernière</b> · ' : ''}${fmtDate(a.visiteLe || a.archiveLe)} · <b>${esc(a.visitePar || a.archivePar || '?')}</b> · ${esc(ETAT_LIB[a.etat] || a.etat || '')} · ${(a.photos || []).length} photo(s)${a.commentaire ? `<br><small>« ${esc(a.commentaire.length > 100 ? a.commentaire.slice(0, 100) + '…' : a.commentaire)} »</small>` : ''}</li>`).join('')}</ul></details>`;
  }

  function majDistanceFiche() {
    const el = $('#fiche-dist'); if (!el || !ouvert) return;
    const r = PAR_ID[ouvert];
    el.textContent = maPos ? `à ${fmtDist(distance(maPos, r))} ${cap(maPos, r)}` : 'position GPS en attente…';
  }

  async function terminer(id, caseEl) {
    const etat = $('#f-etat').value;
    const v = visites[id] || {};
    const toutes = (v.photos || []).map(p => p.role || 'autre');
    const manque = photosRequises(etat).filter(r => !toutes.includes(r));
    const annuler = (msg) => { caseEl.checked = false; toast(msg); };
    if (!etat) { annuler('Indiquez l\'état du repère'); $('#f-etat').focus(); return; }
    if (manque.length) { annuler('Il manque : ' + manque.map(r => ROLES[r].toLowerCase()).join(' et ')); return; }
    const patch = { statut: 'fait', etat, commentaire: $('#f-comm').value.trim(), visitePar: S.nom(), visiteAppareil: S.appareil(), visiteLe: new Date().toISOString() };
    const details = {};
    if (maPos) { patch.gps = maPos; details.ecart = Math.round(distance(maPos, PAR_ID[id])); details.gps = maPos; }
    await S.maj(id, patch, '✔ Visite terminée – ' + (ETAT_LIB[etat] || etat), details);
    // Copie figée de la visite (jamais modifiée ni supprimée, même si la visite est rouverte puis refaite)
    await S.archiverVisite(id, Object.assign({}, v, patch, details.ecart != null ? { ecartGpsIgn: details.ecart } : {}));
    delete cacheArchives[id];
    toast('Visite terminée et archivée ✔');
    $('#fiche').hidden = true; ouvert = null;   // retour à la carte
  }

  async function rouvrir(id, caseEl) {
    if (!confirm('Rouvrir cette visite pour la refaire ?\n\nLa visite terminée précédente reste archivée telle quelle (fiche et photos) : la nouvelle visite s\'y ajoutera, elle ne la remplacera pas.')) { caseEl.checked = true; return; }
    await S.effacerChamps(id, ['statut', 'visitePar', 'visiteAppareil', 'visiteLe'], '↺ Visite rouverte');
    toast('Visite rouverte');
  }

  // ---------------- Photos ----------------
  $('#input-photo').addEventListener('change', async (e) => {
    const id = e.target.dataset.id, role = e.target.dataset.role || 'autre';
    const fichiers = Array.from(e.target.files || []);
    e.target.value = '';
    if (!id || !fichiers.length) return;
    toast('Traitement de ' + fichiers.length + ' photo(s)…');
    // On prépare d'abord les nouvelles photos : l'ancienne n'est retirée que si la nouvelle est prête
    const pretes = [];
    for (const f of (role === 'autre' ? fichiers : fichiers.slice(0, 1))) {
      try {
        const blob = await compresser(f);
        // Traçabilité (jamais bloquante) : position du téléphone au moment de la prise (+ âge du point GPS)
        // et, si l'appareil photo l'a inscrite, position et heure contenues dans la photo elle-même (EXIF).
        const meta = { role };
        if (maPos) {
          meta.gps = Object.assign({}, maPos, { age: maPos.t ? Math.max(0, Math.round((Date.now() - Date.parse(maPos.t)) / 1000)) : null });
          meta.ecart = Math.round(distance(maPos, PAR_ID[id]));
        }
        try {
          const ex = await lireExif(f);
          if (ex && ex.gps) { meta.gpsPhoto = ex.gps; meta.ecartPhoto = Math.round(distance(ex.gps, PAR_ID[id])); }
          if (ex && ex.date) meta.datePhoto = ex.date;
        } catch (e) { console.warn('EXIF illisible', e); }
        pretes.push({ blob, meta });
      } catch (err) { console.error(err); toast('Photo non enregistrée : ' + err.message); }
    }
    if (!pretes.length) return;
    // Près / loin : une seule photo par repère, la nouvelle remplace l'ancienne
    if (role !== 'autre') {
      for (const p of ((visites[id] || {}).photos || []).filter(p => p.role === role)) await S.supprimerPhoto(id, p);
    }
    const nouvelles = [];
    for (const { blob, meta } of pretes) {
      try {
        const cle = await S.ajouterPhoto(id, blob, meta);
        if (cle) nouvelles.push(cle);
      } catch (err) { console.error(err); toast('Photo non enregistrée : ' + err.message); }
    }
    afficherFiche(id);
    majEnvoi();
    toast(ROLES[role] + (S.demo ? ' enregistrée' : ' enregistrée, envoi automatique'));
    // Alerte (sans bloquer) si le téléphone est à plus de 100 m du repère
    const ecart = maPos ? distance(maPos, PAR_ID[id]) : null;
    if (ecart != null && ecart > ECART_ALERTE) {
      await alerteEcart(`Attention : tu es à ${fmtDist(ecart)} de « ${PAR_ID[id].n} ».\nVérifie que c'est bien ce repère que tu photographies. La photo est enregistrée.`);
    }
    // Proposer de pointer le repère sur chaque nouvelle photo
    for (const cle of nouvelles) await pointer(id, cle, true);
  });

  const ECART_ALERTE = 100;   // m
  function alerteEcart(texte) {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    return new Promise(ok => {
      const d = document.createElement('div');
      d.className = 'alerte-ecart';
      d.innerHTML = `<div><p>⚠️</p><p class="txt"></p><button class="btn principal">Compris</button></div>`;
      d.querySelector('.txt').textContent = texte;
      d.querySelector('button').onclick = () => { d.remove(); ok(); };
      document.body.appendChild(d);
    });
  }

  // ---------------- Pointage du repère sur une photo ----------------
  // Position enregistrée en fraction de la largeur / hauteur (0..1) dans visites[id].pointages[cle].
  // La photo d'origine n'est pas modifiée : le rond rouge est dessiné à l'affichage (fiche, fiches de visite).
  function pointer(id, cle, apresPrise) {
    return new Promise(async (ok) => {
      const url = await S.urlPhoto(cle); if (!url) return ok();
      const anc = ((visites[id] || {}).pointages || {})[cle];
      let pt = anc ? { x: anc.x, y: anc.y } : null;
      let taille = (anc && anc.r) || RAYON_DEFAUT;   // rayon du rond en fraction du petit côté de la photo
      const d = document.createElement('div');
      d.className = 'visionneuse pointage';
      d.innerHTML = `<div class="pt-consigne">📍 Touche le repère sur la photo</div>
        <div class="pt-zone"><div class="pt-cadre"><img src="${url}" alt=""><i class="pt-rond" hidden></i></div>
          <div class="pt-taille"><span>⬤</span><input type="range" min="0.015" max="0.25" step="0.005" value="${taille}" aria-label="Taille du rond"><span>·</span></div></div>
        <div class="vis-barre">
          <button class="btn secondaire" id="pt-passer">${apresPrise ? 'Plus tard' : 'Annuler'}</button>
          ${anc ? '<button class="btn secondaire" id="pt-effacer">Effacer le point</button>' : ''}
          <button class="btn principal" id="pt-ok" ${pt ? '' : 'disabled'}>Valider</button></div>`;
      document.body.appendChild(d);
      const img = d.querySelector('img'), rond = d.querySelector('.pt-rond'), okBtn = d.querySelector('#pt-ok');
      const placer = () => {
        if (!pt) return;
        const dia = Math.max(14, 2 * taille * Math.min(img.clientWidth, img.clientHeight));
        rond.hidden = false; rond.style.left = (pt.x * 100) + '%'; rond.style.top = (pt.y * 100) + '%';
        rond.style.width = rond.style.height = dia + 'px'; rond.style.margin = (-dia / 2) + 'px 0 0 ' + (-dia / 2) + 'px';
      };
      img.onload = placer;
      d.querySelector('.pt-taille input').oninput = (e) => { taille = +e.target.value; placer(); if (pt) okBtn.disabled = false; };
      img.onclick = (e) => {
        const b = img.getBoundingClientRect();
        pt = { x: +((e.clientX - b.left) / b.width).toFixed(4), y: +((e.clientY - b.top) / b.height).toFixed(4) };
        placer(); okBtn.disabled = false;
      };
      const fin = () => { d.remove(); ok(); };
      d.querySelector('#pt-passer').onclick = fin;
      const eff = d.querySelector('#pt-effacer');
      if (eff) eff.onclick = async () => {
        await S.maj(id, { pointages: Object.assign({}, (visites[id] || {}).pointages, { [cle]: null }) }, 'Pointage effacé sur la ' + nomPhoto(id, cle)); toast('Point effacé'); fin();
      };
      okBtn.onclick = async () => {
        await S.maj(id, { pointages: Object.assign({}, (visites[id] || {}).pointages, { [cle]: Object.assign({}, pt, { r: +taille.toFixed(3) }) }) }, (anc ? 'Repère repointé' : 'Repère pointé') + ' sur la ' + nomPhoto(id, cle));
        toast('Repère pointé ✔'); fin();
      };
    });
  }

  const nomPhoto = (id, cle) => {
    const p = ((visites[id] || {}).photos || []).find(x => x.cle === cle);
    return ({ pres: 'photo de près', loin: 'photo de loin' })[p && p.role] || 'autre photo';
  };

  // Image avec le rond rouge dessiné dessus (mise en cache)
  const RAYON_DEFAUT = 0.05;
  const cacheMarquees = {};
  async function urlMarquee(url, pt) {
    const k = url + '|' + pt.x + '|' + pt.y + '|' + (pt.r || RAYON_DEFAUT);
    if (cacheMarquees[k]) return cacheMarquees[k];
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const m = Math.min(c.width, c.height), r = m * (pt.r || RAYON_DEFAUT);
    g.lineWidth = Math.max(3, m * 0.012);
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(pt.x * c.width, pt.y * c.height, r + g.lineWidth, 0, 2 * Math.PI); g.stroke();
    g.strokeStyle = '#e00000'; g.beginPath(); g.arc(pt.x * c.width, pt.y * c.height, r, 0, 2 * Math.PI); g.stroke();
    const b = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85));
    return (cacheMarquees[k] = URL.createObjectURL(b));
  }

  // Lecture EXIF minimale d'un JPEG : position GPS (GPSLatitude / GPSLongitude / GPSAltitude) et DateTimeOriginal.
  // Renvoie null si absent (beaucoup de téléphones retirent la position des photos transmises aux pages web).
  async function lireExif(fichier) {
    const buf = await fichier.slice(0, 256 * 1024).arrayBuffer();
    const d = new DataView(buf);
    if (d.byteLength < 4 || d.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 4 < d.byteLength) {
      const marq = d.getUint16(o), lg = d.getUint16(o + 2);
      if (marq === 0xFFE1 && d.getUint32(o + 4) === 0x45786966) {   // "Exif"
        const t = o + 10, le = d.getUint16(t) === 0x4949;
        const u16 = (p) => d.getUint16(t + p, le), u32 = (p) => d.getUint32(t + p, le);
        const lireIfd = (p) => { const n = u16(p), tags = {}; for (let i = 0; i < n; i++) { const e = p + 2 + i * 12; tags[u16(e)] = { type: u16(e + 2), nb: u32(e + 4), val: e + 8 }; } return tags; };
        const rat = (p, k) => { const a = u32(p + 8 * k), b = u32(p + 8 * k + 4); return b ? a / b : 0; };
        const ascii = (tag) => { const p = tag.nb > 4 ? u32(tag.val) : tag.val; let s = ''; for (let i = 0; i < tag.nb - 1; i++) s += String.fromCharCode(d.getUint8(t + p + i)); return s; };
        const ifd0 = lireIfd(u32(4)), res = {};
        if (ifd0[0x8769]) { const ex = lireIfd(u32(ifd0[0x8769].val)); if (ex[0x9003]) { const s = ascii(ex[0x9003]); const m = s.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/); if (m) res.date = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`; } }
        if (ifd0[0x8825]) {
          const g = lireIfd(u32(ifd0[0x8825].val));
          const dms = (tag) => { const p = u32(tag.val); return rat(p, 0) + rat(p, 1) / 60 + rat(p, 2) / 3600; };
          if (g[2] && g[4]) {
            let lat = dms(g[2]), lon = dms(g[4]);
            if (g[1] && String.fromCharCode(d.getUint8(t + g[1].val)) === 'S') lat = -lat;
            if (g[3] && String.fromCharCode(d.getUint8(t + g[3].val)) === 'W') lon = -lon;
            if (lat || lon) { res.gps = { lat: +lat.toFixed(7), lon: +lon.toFixed(7) }; if (g[6]) res.gps.alt = +rat(u32(g[6].val), 0).toFixed(1); }
          }
        }
        return (res.gps || res.date) ? res : null;
      }
      if ((marq & 0xFF00) !== 0xFF00) break;
      o += 2 + lg;
    }
    return null;
  }

  // Réduit la photo à 2048 px (puis 1600, 1280 si besoin) en baissant la qualité jusqu'à tenir sous 700 Ko :
  // vise une photo de 600-700 Ko. Plafond imposé par Firestore : 1 Mo par document et le base64 ajoute
  // un tiers (700 Ko → ~956 000 caractères, sous la limite de 1 000 000 des règles).
  const TAILLE_MAX = 700 * 1024;
  function dessiner(fichier, maxCote) {
    return new Promise((ok, ko) => {
      const img = new Image();
      const url = URL.createObjectURL(fichier);
      img.onload = () => {
        const k = Math.min(1, maxCote / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('image illisible')); };
      img.src = url;
    });
  }
  const versJpeg = (c, q) => new Promise((ok, ko) => c.toBlob(b => b ? ok(b) : ko(new Error('compression impossible')), 'image/jpeg', q));
  async function compresser(fichier) {
    const essais = [[2048, [0.9, 0.86, 0.82, 0.78, 0.72]], [1600, [0.82, 0.72, 0.62]], [1280, [0.72, 0.6, 0.5]]];
    for (const [cote, qualites] of essais) {
      const c = await dessiner(fichier, cote);
      for (const q of qualites) {
        const b = await versJpeg(c, q);
        if (b.size <= TAILLE_MAX) return b;
      }
    }
    throw new Error('photo trop lourde même réduite');
  }

  async function voirPhoto(id, i) {
    const p = ((visites[id] || {}).photos || [])[i]; if (!p) return;
    let url = p.cle ? await S.urlPhoto(p.cle) : null;
    const pt = ((visites[id] || {}).pointages || {})[p.cle];
    if (url && pt) try { url = await urlMarquee(url, pt); } catch (e) { }
    const d = document.createElement('div');
    d.className = 'visionneuse';
    d.innerHTML = `${url ? `<img src="${url}" alt="">` : `<div class="vis-absente">⏳ Photo pas encore envoyée par le téléphone de ${esc(p.auteur || '?')}.<br>Elle arrivera dès qu'il aura du réseau.</div>`}
      <div class="vis-barre">
      <span>${ROLES[p.role || 'autre']} · ${esc(p.auteur || '')} · ${fmtDate(p.date)}</span>
      <button class="btn secondaire" id="vis-suppr">Supprimer</button>
      ${url ? `<button class="btn" id="vis-pointer">📍 ${pt ? 'Repointer' : 'Pointer le repère'}</button>` : ''}
      <button class="btn" id="vis-fermer">Fermer</button></div>`;
    document.body.appendChild(d);
    d.querySelector('#vis-fermer').onclick = () => d.remove();
    const bp = d.querySelector('#vis-pointer');
    if (bp) bp.onclick = async () => { d.remove(); await pointer(id, p.cle, false); };
    const img = d.querySelector('img'); if (img) img.onclick = () => d.remove();
    d.querySelector('#vis-suppr').onclick = async () => {
      if (!confirm('Supprimer définitivement cette photo ?')) return;
      await S.supprimerPhoto(id, p); d.remove(); majEnvoi(); toast('Photo supprimée');
    };
  }

  // ---------------- Envoi des photos ----------------
  const fmtMo = (o) => (o / 1048576).toFixed(o < 10485760 ? 1 : 0).replace('.', ',') + ' Mo';
  async function majEnvoi() {
    const metas = await S.photosLocales();
    const attente = metas.filter(m => !m.envoye);
    // Photos déjà dans Firebase mais encore gardées sur ce téléphone (place libérable)
    const liberables = S.demo ? [] : metas.filter(m => m.envoye);
    if (attente.length && !S.demo) $('#prog-texte').dataset.attente = `⏳ ${attente.length} photo(s) à envoyer`; else delete $('#prog-texte').dataset.attente;
    $('#envoi-etat').innerHTML = S.demo
      ? `Mode local : ${metas.length} photo(s) sur ce téléphone, non partagées.`
      : attente.length
        ? `⏳ <b>${attente.length} photo(s)</b> en attente d'envoi (${fmtMo(attente.reduce((s, m) => s + (m.taille || 0), 0))}). Envoi automatique dès que le réseau le permet.`
        : '✔ Toutes les photos sont envoyées.';
    $('#envoi-local').textContent = liberables.length
      ? `${liberables.length} photo(s) déjà envoyées, encore gardées sur ce téléphone (${fmtMo(liberables.reduce((s, m) => s + (m.taille || 0), 0))}).` : '';
    $('#btn-envoyer').hidden = S.demo || !attente.length;
    $('#btn-liberer').hidden = !liberables.length;
  }

  // ---------------- Liste / UI ----------------
  function remplirListe() {
    const q = $('#recherche').value.trim().toLowerCase();
    let items = REPERES.filter(visible).filter(r => !q || r.n.toLowerCase().includes(q) || r.c.toLowerCase().includes(q));
    items = items.map(r => ({ r, d: maPos ? distance(maPos, r) : null }))
      .sort((a, b) => (a.d == null || b.d == null) ? a.r.c.localeCompare(b.r.c) || a.r.n.localeCompare(b.r.n) : a.d - b.d)
      .slice(0, 80);
    $('#liste h2').textContent = maPos ? 'Repères les plus proches' : 'Repères (GPS en attente)';
    $('#liste-items').innerHTML = items.map(({ r, d }) => {
      const sv = statutVisuel(visites[r.id]);
      return `<li data-id="${r.id}"><i class="pastille ${sv}"></i><div><b>${esc(r.n)}</b> <small>${r.t}</small><br><small>${esc(r.c)}</small></div><span>${d != null ? fmtDist(d) + ' ' + cap(maPos, r) : ''}</span></li>`;
    }).join('') || '<li>Aucun repère</li>';
    document.querySelectorAll('#liste-items li[data-id]').forEach(li => li.onclick = () => {
      const r = PAR_ID[li.dataset.id];
      map.setView([r.lat, r.lon], Math.max(map.getZoom(), 17));
      afficherFiche(r.id);
    });
  }

  function toast(t) {
    const el = $('#toast'); el.textContent = t; el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => el.hidden = true, 2600);
  }

  function initUI() {
    document.querySelectorAll('[data-ferme]').forEach(b => b.onclick = () => {
      $('#' + b.dataset.ferme).hidden = true;
      if (b.dataset.ferme === 'fiche') ouvert = null;
    });
    $('#btn-liste').onclick = () => { $('#fiche').hidden = true; ouvert = null; $('#menu').hidden = true; $('#liste').hidden = false; remplirListe(); };
    $('#recherche').oninput = remplirListe;
    $('#btn-menu').onclick = () => { $('#menu').hidden = !$('#menu').hidden; };
    $('#btn-moi').onclick = () => {
      if (!maPos) { toast('Position GPS pas encore disponible'); return; }
      suivi = true; $('#btn-moi').classList.add('actif');
      map.setView([maPos.lat, maPos.lon], Math.max(map.getZoom(), 16));
    };
    document.querySelectorAll('#filtres .chip[data-type]').forEach(c => c.onclick = () => {
      filtre[c.dataset.type] = !filtre[c.dataset.type]; c.classList.toggle('actif', filtre[c.dataset.type]); rafraichir();
    });
    // Calque « visites terminées » : affichées → masquées → seules → affichées…
    const majChipTerminees = () => {
      $('#chip-terminees').textContent = TERMINEES[filtre.terminees];
      $('#chip-terminees').classList.toggle('actif', filtre.terminees !== 'afficher');
    };
    majChipTerminees();
    $('#chip-terminees').onclick = () => {
      const ordre = Object.keys(TERMINEES);
      filtre.terminees = ordre[(ordre.indexOf(filtre.terminees) + 1) % ordre.length];
      localStorage.setItem('calque-terminees', filtre.terminees);
      majChipTerminees(); rafraichir();
    };
    $('#menu-nom').onchange = () => { localStorage.setItem('nom-terrain', $('#menu-nom').value.trim()); toast('Nom enregistré'); };
    $('#sel-theme').value = localStorage.getItem('theme') || 'auto';
    $('#sel-theme').onchange = (e) => { localStorage.setItem('theme', e.target.value); appliquerTheme(); };
    $('#btn-envoyer').onclick =() => { if (!navigator.onLine) { toast('Pas de réseau pour l\'instant'); return; } S.envoyerFile(); toast('Envoi relancé'); };
    $('#btn-liberer').onclick = async () => {
      if (!confirm('Retirer de ce téléphone les photos déjà envoyées ?\n\nElles restent dans l\'appli (téléchargées depuis le serveur quand on les ouvre, avec du réseau).')) return;
      const n = await S.libererPlace(); majEnvoi(); if (ouvert) afficherFiche(ouvert); toast(n + ' photo(s) retirée(s) du téléphone');
    };
    $('#btn-menu').addEventListener('click', majEnvoi);
    $('#btn-deconnexion').onclick =() => { $('#menu').hidden = true; S.deconnexion(); };
    // Plus d'export depuis le téléphone : le tableau et la couche SIG du livrable sont produits
    // sur le serveur du cabinet par rapatrier-photos.ps1 (visites_lot2.csv / .geojson).
  }
})();
