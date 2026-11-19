// Appli de terrain – vérification des repères IGN du lot 2 (Montpellier Méditerranée Métropole)
(function () {
  const S = window.Stockage;
  const REPERES = window.REPERES;
  const PAR_ID = Object.fromEntries(REPERES.map(r => [r.id, r]));
  const ETATS = [
    ['bon', 'Bon état'],
    ['endommage', 'Endommagé'],
    ['deplace', 'Présumé déplacé'],
    ['detruit', 'Détruit'],
    ['introuvable', 'Introuvable'],
    ['inaccessible', 'Inaccessible (propriété privée, travaux…)']
  ];
  const ETAT_LIB = Object.fromEntries(ETATS);
  const ETATS_SANS_PHOTO = ['introuvable', 'inaccessible', 'detruit'];
  const PROBLEMES = ['detruit', 'introuvable'];
  // Photos attendues pour la fiche de visite : une de près, une de loin, puis autant d'« autres » que voulu.
  const ROLES = { pres: 'Photo de près', loin: 'Photo de loin', autre: 'Autre photo' };
  // Boîte qui reçoit les envois par mail (lue au bureau par importer-mails.ps1)
  const ADRESSE_BUREAU = 'nicolas.midonnet@siragusa.fr';
  const TERMINEES = { afficher: 'Visites terminées : affichées', masquer: 'Visites terminées : masquées', seules: 'Visites terminées seulement' };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let visites = {};          // id -> visite (données partagées)
  let ouvert = null;         // id du repère affiché dans la fiche
  let maPos = null;          // {lat, lon, acc}
  const filtre = { RBF: true, NGF: true, terminees: localStorage.getItem('calque-terminees') || 'afficher' };
  let map, marqueurs = {}, coucheMoi = null, cercleMoi = null, suivi = false, desabonner = null;

  // ---------------- Démarrage ----------------
  S.init();
  if (S.demo) {
    $('#mode-demo').hidden = false;
    // Mode local : pas de compte, on demande seulement le prénom (affiché sur les réservations et visites)
    const em = $('#cx-email'), mdp = $('#cx-mdp');
    em.type = 'text'; em.autocomplete = 'given-name'; em.placeholder = 'ex. Jack';
    em.value = localStorage.getItem('nom-terrain') || '';
    em.closest('label').firstChild.textContent = 'Ton prénom';
    mdp.required = false; mdp.closest('label').hidden = true;
    $('#form-connexion button').textContent = 'Commencer';
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  S.onAuth(u => {
    $('#ecran-connexion').hidden = !!u;
    $('#ecran-app').hidden = !u;
    if (u) demarrerApp(); else if (desabonner) { desabonner(); desabonner = null; }
  });

  $('#form-connexion').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#cx-erreur').textContent = '';
    if (S.demo) localStorage.setItem('nom-terrain', $('#cx-email').value.trim());
    try { await S.connexion($('#cx-email').value.trim(), $('#cx-mdp').value); }
    catch (err) { $('#cx-erreur').textContent = messageErreur(err); }
  });

  function messageErreur(err) {
    const c = (err && err.code) || '';
    if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'E-mail ou mot de passe incorrect.';
    if (c.includes('network')) return 'Pas de réseau. Réessayez.';
    if (c.includes('too-many-requests')) return 'Trop de tentatives, patientez une minute.';
    return (err && err.message) || 'Erreur inconnue';
  }

  let appDemarree = false;
  function demarrerApp() {
    if (S.demo) $('#btn-deconnexion').textContent = 'Changer de prénom';
    $('#menu-user').textContent = S.demo ? 'Mode local (relevés gardés sur ce téléphone)' : 'Connecté : ' + (S.user.email || '');
    $('#menu-nom').value = localStorage.getItem('nom-terrain') || '';
    if (!appDemarree) { initCarte(); initUI(); appDemarree = true; }
    desabonner = S.ecouter((v) => { visites = v || {}; rafraichir(); });
    majEnvoi();
    S.onFileChange = () => { majEnvoi(); if (ouvert) afficherFiche(ouvert, true); };
  }

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
    $('#sel-fond').value = fond;
    $('#sel-fond').onchange = (e) => { map.removeLayer(actif); fond = e.target.value; actif = fonds[fond].addTo(map); actif.bringToBack(); localStorage.setItem('fond', fond); };

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
        maPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) };
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
    if (!v) return 'afaire';
    if (v.statut === 'fait') return PROBLEMES.includes(v.etat) ? 'probleme' : 'fait';
    if (v.statut === 'reserve') return 'reserve';
    return 'afaire';
  }

  function icone(r, v) {
    const sv = statutVisuel(v);
    const nonRetrouveIGN = r.e && r.e !== 'Bon état' ? ' ign-alerte' : '';
    const forme = r.t === 'RBF' ? 'tri' : 'rond';
    return L.divIcon({
      className: 'mq', iconSize: [26, 26], iconAnchor: [13, 13],
      html: `<div class="mq-${forme} s-${sv}${nonRetrouveIGN}"></div>`
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
    const reserves = cibles.filter(r => visites[r.id] && visites[r.id].statut === 'reserve').length;
    $('#prog-texte').textContent = `${faits} / ${cibles.length} visités · ${reserves} réservés`;
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
    const moi = S.nom();
    const photos = (v.photos || []);
    // Les photos sont sur le téléphone qui les a prises : on affiche celles présentes ici
    const urls = {};
    for (const p of photos) if (p.cle) {
      urls[p.cle] = await S.urlPhoto(p.cle);
      const pt = (v.pointages || {})[p.cle];
      if (urls[p.cle] && pt) try { urls[p.cle] = await urlMarquee(urls[p.cle], pt); } catch (e) { }
    }
    if (ouvert !== id) return;   // une autre fiche a été ouverte entre-temps
    const precisionPos = r.t === 'NGF' ? 'Position IGN approchée (~10 m) : cherchez l\'édifice décrit.' : '';

    const libStatut = {
      afaire: 'À faire',
      reserve: `Réservé par ${esc(v.reservePar || '?')}`,
      fait: `Visite terminée par ${esc(v.visitePar || '?')} le ${fmtDate(v.visiteLe)}`,
      probleme: `${esc(ETAT_LIB[v.etat] || '')} – constaté par ${esc(v.visitePar || '?')} le ${fmtDate(v.visiteLe)}`
    }[sv];

    // Photos rangées par rôle (près / loin / autres). Les anciennes photos sans rôle comptent comme « autre ».
    const indexees = photos.map((p, i) => Object.assign({ i }, p));
    const parRole = (role) => indexees.filter(p => (p.role || 'autre') === role);
    const vignette = (p) => urls[p.cle]
      ? `<figure><img src="${urls[p.cle]}" data-i="${p.i}" alt=""><figcaption>${(v.pointages || {})[p.cle] ? '📍 ' : ''}${p.gps && distance(p.gps, r) > ECART_ALERTE ? `⚠️ prise à ${fmtDist(distance(p.gps, r))} · ` : ''}${esc(p.auteur || '')} · ${fmtDate(p.date)}</figcaption></figure>`
      : `<figure class="ailleurs" data-i="${p.i}"><div class="photo-absente">📱<br>sur le téléphone de ${esc(p.auteur || '?')}</div><figcaption>${fmtDate(p.date)}</figcaption></figure>`;
    const emplacement = (role) => {
      const ph = parRole(role).slice(-1)[0];
      const contenu = ph ? vignette(ph) : '';
      return `<div class="emplacement ${contenu ? 'rempli' : ''}">
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
        <a class="btn fiche-ign" href="${esc(r.u)}" target="_blank" rel="noopener">📄 Ouvrir la fiche IGN originale</a>
      </div>
      <div class="actions">
        <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}&travelmode=driving" target="_blank" rel="noopener">🧭 Itinéraire</a>
        ${sv === 'afaire' ? `<button class="btn" id="b-reserver">✋ Je le prends</button>` : ''}
        ${sv === 'reserve' ? `<button class="btn" id="b-liberer">${v.reservePar === moi ? 'Libérer' : 'Libérer (' + esc(v.reservePar) + ')'}</button>` : ''}
      </div>
      <details class="ign">
        <summary>Données IGN</summary>
        <p class="pre">${esc(r.l)}</p>
        <p>État IGN : <b class="${r.e !== 'Bon état' ? 'alerte' : ''}">${esc(r.e)}</b></p>
        <p class="petit">${precisionPos} WGS84 : ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}</p>
      </details>

      <h3>Photos de la visite</h3>
      <div class="emplacements">${emplacement('pres')}${emplacement('loin')}</div>
      <div class="photos">
        ${parRole('autre').map(vignette).join('')}
        <button class="photo-ajout" data-role="autre">📷<br>Autre photo</button>
      </div>

      <h3>État du repère</h3>
      <label>État constaté
        <select id="f-etat">
          <option value="">— choisir —</option>
          ${ETATS.map(([k, l]) => `<option value="${k}" ${v.etat === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <label>Commentaire (repris sur la fiche de visite)
        <textarea id="f-comm" rows="3" placeholder="État du repère, accès, environnement…">${esc(v.commentaire || '')}</textarea>
      </label>

      <label class="case-terminee ${terminee ? 'cochee' : ''}">
        <input type="checkbox" id="f-terminee" ${terminee ? 'checked' : ''}>
        <span>Visite terminée</span>
      </label>
      ${(v.journal || []).length ? `<details class="historique"><summary>Journal des modifications (${v.journal.length})</summary><ul>${[...v.journal].reverse().map(h =>
        `<li>${fmtDate(h.le)} · <b>${esc(h.par || '?')}</b> · ${esc(h.action)}${h.ecart != null ? ` <span class="${h.ecart > ECART_ALERTE ? 'alerte' : ''}">(à ${fmtDist(h.ecart)} du repère)</span>` : ''}</li>`).join('')}</ul></details>` : ''}
      ${v.maj ? `<p class="petit">Dernière modification : ${esc(v.majPar || '')} – ${fmtDate(v.maj)}</p>` : ''}
    `;
    $('#fiche').hidden = false;
    $('#liste').hidden = true;
    majDistanceFiche();

    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#b-reserver', () => S.maj(id, { statut: 'reserve', reservePar: moi, reserveLe: new Date().toISOString() }, 'Réservé').then(() => toast('Repère réservé')));
    on('#b-liberer', () => S.effacerChamps(id, ['statut', 'reservePar', 'reserveLe'], 'Réservation libérée' + (v.reservePar && v.reservePar !== moi ? ' (était à ' + v.reservePar + ')' : '')).then(() => toast('Réservation libérée')));
    document.querySelectorAll('#fiche .photo-ajout').forEach(b => b.onclick = () => {
      const inp = $('#input-photo');
      inp.dataset.id = id; inp.dataset.role = b.dataset.role;
      inp.multiple = b.dataset.role === 'autre';
      inp.click();
    });
    document.querySelectorAll('#fiche img[data-i], #fiche .ailleurs[data-i]').forEach(el => el.onclick = () => voirPhoto(id, +el.dataset.i));
    // Enregistrement automatique de l'état et du commentaire
    $('#f-etat').onchange = () => S.maj(id, { etat: $('#f-etat').value }, 'État : ' + (ETAT_LIB[$('#f-etat').value] || '—') + (v.etat ? ' (avant : ' + (ETAT_LIB[v.etat] || v.etat) + ')' : ''));
    $('#f-comm').onblur = () => {
      const c = $('#f-comm').value.trim();
      if (c !== (v.commentaire || '')) S.maj(id, { commentaire: c }, 'Commentaire : « ' + (c.length > 80 ? c.slice(0, 80) + '…' : c) + ' »');
    };
    $('#f-terminee').onchange = (e) => e.target.checked ? terminer(id, e.target) : rouvrir(id, e.target);
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
    const manque = ['pres', 'loin'].filter(r => !toutes.includes(r));
    const annuler = (msg) => { caseEl.checked = false; toast(msg); };
    if (!etat) { annuler('Indiquez l\'état du repère'); $('#f-etat').focus(); return; }
    if (manque.length && !ETATS_SANS_PHOTO.includes(etat)) { annuler('Il manque : ' + manque.map(r => ROLES[r].toLowerCase()).join(' et ')); return; }
    const patch = { statut: 'fait', etat, commentaire: $('#f-comm').value.trim(), visitePar: S.nom(), visiteLe: new Date().toISOString() };
    const details = {};
    if (maPos) { patch.gps = maPos; details.ecart = Math.round(distance(maPos, PAR_ID[id])); details.gps = maPos; }
    await S.maj(id, patch, '✔ Visite terminée – ' + (ETAT_LIB[etat] || etat), details);
    toast('Visite terminée ✔');
    $('#fiche').hidden = true; ouvert = null;   // retour à la carte
  }

  async function rouvrir(id, caseEl) {
    if (!confirm('Rouvrir cette visite ? Les photos et le commentaire sont conservés.')) { caseEl.checked = true; return; }
    await S.effacerChamps(id, ['statut', 'visitePar', 'visiteLe'], '↺ Visite rouverte');
    toast('Visite rouverte');
  }

  // ---------------- Photos ----------------
  $('#input-photo').addEventListener('change', async (e) => {
    const id = e.target.dataset.id, role = e.target.dataset.role || 'autre';
    const fichiers = Array.from(e.target.files || []);
    e.target.value = '';
    if (!id || !fichiers.length) return;
    toast('Traitement de ' + fichiers.length + ' photo(s)…');
    // Près / loin : une seule photo par repère, la nouvelle remplace l'ancienne
    if (role !== 'autre') {
      for (const p of ((visites[id] || {}).photos || []).filter(p => p.role === role)) await S.supprimerPhoto(id, p);
    }
    const nouvelles = [];
    for (const f of (role === 'autre' ? fichiers : fichiers.slice(0, 1))) {
      try {
        const blob = await compresser(f);
        const meta = Object.assign({ role }, maPos ? { gps: maPos, ecart: Math.round(distance(maPos, PAR_ID[id])) } : {});
        const cle = await S.ajouterPhoto(id, blob, meta);
        if (cle) nouvelles.push(cle);
      } catch (err) { console.error(err); toast('Photo non enregistrée : ' + err.message); }
    }
    // Un repère « à faire » sur lequel on prend une photo passe en « réservé » pour éviter un doublon de déplacement
    const v = visites[id];
    if (!v || !v.statut) S.maj(id, { statut: 'reserve', reservePar: S.nom(), reserveLe: new Date().toISOString() }, 'Réservé (photo prise)');
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
      const d = document.createElement('div');
      d.className = 'visionneuse pointage';
      d.innerHTML = `<div class="pt-consigne">📍 Touche le repère sur la photo</div>
        <div class="pt-zone"><div class="pt-cadre"><img src="${url}" alt=""><i class="pt-rond" hidden></i></div></div>
        <div class="vis-barre">
          <button class="btn secondaire" id="pt-passer">${apresPrise ? 'Plus tard' : 'Annuler'}</button>
          ${anc ? '<button class="btn secondaire" id="pt-effacer">Effacer le point</button>' : ''}
          <button class="btn principal" id="pt-ok" ${pt ? '' : 'disabled'}>Valider</button></div>`;
      document.body.appendChild(d);
      const img = d.querySelector('img'), rond = d.querySelector('.pt-rond'), okBtn = d.querySelector('#pt-ok');
      const placer = () => { if (!pt) return; rond.hidden = false; rond.style.left = (pt.x * 100) + '%'; rond.style.top = (pt.y * 100) + '%'; };
      img.onload = placer;
      img.onclick = (e) => {
        const b = img.getBoundingClientRect();
        pt = { x: +((e.clientX - b.left) / b.width).toFixed(4), y: +((e.clientY - b.top) / b.height).toFixed(4) };
        placer(); okBtn.disabled = false;
      };
      const fin = () => { d.remove(); ok(); };
      d.querySelector('#pt-passer').onclick = fin;
      const eff = d.querySelector('#pt-effacer');
      if (eff) eff.onclick = async () => {
        const p = Object.assign({}, (visites[id] || {}).pointages); delete p[cle];
        await S.maj(id, { pointages: p }, 'Pointage effacé sur la ' + nomPhoto(id, cle)); toast('Point effacé'); fin();
      };
      okBtn.onclick = async () => {
        await S.maj(id, { pointages: Object.assign({}, (visites[id] || {}).pointages, { [cle]: pt }) }, (anc ? 'Repère repointé' : 'Repère pointé') + ' sur la ' + nomPhoto(id, cle));
        toast('Repère pointé ✔'); fin();
      };
    });
  }

  const nomPhoto = (id, cle) => {
    const p = ((visites[id] || {}).photos || []).find(x => x.cle === cle);
    return ({ pres: 'photo de près', loin: 'photo de loin' })[p && p.role] || 'autre photo';
  };

  // Image avec le rond rouge dessiné dessus (mise en cache)
  const cacheMarquees = {};
  async function urlMarquee(url, pt) {
    const k = url + '|' + pt.x + '|' + pt.y;
    if (cacheMarquees[k]) return cacheMarquees[k];
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const m = Math.min(c.width, c.height), r = m * 0.05;
    g.lineWidth = Math.max(3, m * 0.012);
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(pt.x * c.width, pt.y * c.height, r + g.lineWidth, 0, 2 * Math.PI); g.stroke();
    g.strokeStyle = '#e00000'; g.beginPath(); g.arc(pt.x * c.width, pt.y * c.height, r, 0, 2 * Math.PI); g.stroke();
    const b = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85));
    return (cacheMarquees[k] = URL.createObjectURL(b));
  }

  // Réduit la photo à 1600 px puis baisse la qualité jusqu'à tenir sous ~650 Ko
  // (limite Firestore : 1 Mo par document, et le base64 ajoute un tiers).
  const TAILLE_MAX = 650 * 1024;
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
    for (const cote of [1600, 1280]) {
      const c = await dessiner(fichier, cote);
      for (const q of [0.82, 0.72, 0.62, 0.5]) {
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
    const attente = metas.filter(m => !m.envoye), envoyees = metas.filter(m => m.envoye);
    if (attente.length) $('#prog-texte').dataset.attente = `⏳ ${attente.length} photo(s) à envoyer`; else delete $('#prog-texte').dataset.attente;
    // Envoi par mail : photos pas encore parties dans un ZIP
    const miennes = metas.filter(m => !m.importe);
    const aMailer = miennes.filter(m => !m.exporte), mailees = miennes.filter(m => m.exporte);
    const parties = (m) => (m.envoye && !S.demo) || m.exporte;
    const liberables = metas.filter(parties);
    if (S.demo) {
      if (aMailer.length) $('#prog-texte').dataset.attente = `📤 ${aMailer.length} photo(s) pas encore partagée(s)`; else delete $('#prog-texte').dataset.attente;
      const tot = metas.reduce((s, m) => s + (m.taille || 0), 0);
      $('#envoi-etat').innerHTML = `Ce téléphone contient <b>${metas.length} photo(s)</b> (${fmtMo(tot)}), dont ${miennes.length} prise(s) ici`
        + (aMailer.length ? ` et <b>${aMailer.length}</b> jamais partagée(s).` : '.');
    } else {
      if (attente.length) $('#prog-texte').dataset.attente = `⏳ ${attente.length} photo(s) à envoyer`; else delete $('#prog-texte').dataset.attente;
      $('#envoi-etat').innerHTML = attente.length
        ? `⏳ <b>${attente.length} photo(s)</b> en attente d'envoi (${fmtMo(attente.reduce((s, m) => s + (m.taille || 0), 0))}). Envoi automatique dès que le réseau le permet.`
        : '✔ Toutes les photos sont envoyées.';
    }
    $('#envoi-local').textContent = liberables.length
      ? `${liberables.length} photo(s) déjà parties, encore gardées sur ce téléphone (${fmtMo(liberables.reduce((s, m) => s + (m.taille || 0), 0))}).` : '';
    $('#btn-envoyer').hidden = S.demo || !attente.length;
    $('#btn-mail').disabled = false;   // partage possible même sans photo (état des visites)
    $('#btn-liberer').hidden = !liberables.length;
  }

  // Partage du ou des ZIP (Android : choisir Gmail / Outlook). Sans partage possible : téléchargement.
  // Le fichier = état complet de l'appli sur ce téléphone : toutes ses photos (depuis le début)
  // + toutes les visites. L'import chez les autres ignore ce qu'ils ont déjà.
  async function envoyerParMail() {
    const b = $('#btn-mail');
    const libelle = b.textContent; b.disabled = true; b.textContent = 'Préparation…';
    try {
      const lots = await S.construireZips(REPERES, visites, true);
      const jour = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      const qui = S.nom().replace(/[^\w-]+/g, '');
      const fichiers = lots.map((l, k) => new File([l.zip], `reperes3m_${qui}_${jour}${lots.length > 1 ? '_' + (k + 1) + 'sur' + lots.length : ''}.zip`, { type: 'application/zip' }));
      const nbPhotos = lots.reduce((s, l) => s + l.cles.length, 0);
      const texte = `Repères 3M lot 2 – relevés de ${S.nom()} (${nbPhotos} photo(s)). À importer dans l'appli (menu ☰ > Importer un fichier reçu) et à envoyer au bureau : ${ADRESSE_BUREAU}.`;
      // Un mail par ZIP (chaque pièce jointe < 18 Mo)
      for (let k = 0; k < fichiers.length; k++) {
        const f = fichiers[k];
        let partage = false;
        if (navigator.canShare && navigator.canShare({ files: [f] })) {
          if (fichiers.length > 1 && k > 0 && !confirm(`Envoyer la partie ${k + 1} sur ${fichiers.length} ?`)) break;
          try { await navigator.share({ files: [f], title: f.name, text: texte }); partage = true; }
          catch (e) { if (e.name === 'AbortError') { toast('Envoi annulé'); return; } }
        }
        if (!partage) telecharger(f.name, f, 'application/zip');
      }
      // Date du dernier partage (sert à « Libérer la place »)
      await S.marquerExportees(lots.flatMap(l => l.cles));
      toast(`Fichier partagé : ${nbPhotos} photo(s) + état des visites`);
    } catch (e) { console.error(e); alert('Préparation impossible : ' + e.message); }
    finally { b.textContent = libelle; majEnvoi(); }
  }

  // Import du ou des fichiers reçus d'un collègue
  async function importerFichiers(fichiers) {
    const avecPhotos = $('#imp-photos').checked;
    const bilans = [];
    for (const f of fichiers) {
      try {
        const b = await S.importerZip(f, avecPhotos);
        bilans.push(`✔ ${f.name}\n   ${b.auteur || '?'} – ${b.nbVisites} repère(s) mis à jour, ${b.nbPhotos} photo(s) ajoutée(s)`);
      } catch (e) { console.error(e); bilans.push(`✖ ${f.name} : ${e.message}`); }
    }
    majEnvoi();
    if (ouvert) afficherFiche(ouvert);
    alert('Import terminé\n\n' + bilans.join('\n'));
  }

  // ---------------- Liste / UI ----------------
  function remplirListe() {
    const q = $('#recherche').value.trim().toLowerCase();
    let items = REPERES.filter(visible).filter(r => !q || r.n.toLowerCase().includes(q) || r.c.toLowerCase().includes(q));
    const mesRes = $('#liste').dataset.mode === 'mes';
    if (mesRes) items = items.filter(r => visites[r.id] && visites[r.id].statut === 'reserve' && visites[r.id].reservePar === S.nom());
    items = items.map(r => ({ r, d: maPos ? distance(maPos, r) : null }))
      .sort((a, b) => (a.d == null || b.d == null) ? a.r.c.localeCompare(b.r.c) || a.r.n.localeCompare(b.r.n) : a.d - b.d)
      .slice(0, 80);
    $('#liste h2').textContent = mesRes ? 'Mes repères réservés' : (maPos ? 'Repères les plus proches' : 'Repères (GPS en attente)');
    $('#liste-items').innerHTML = items.map(({ r, d }) => {
      const sv = statutVisuel(visites[r.id]);
      return `<li data-id="${r.id}"><i class="pastille ${sv}"></i><div><b>${esc(r.n)}</b> <small>${r.t}</small><br><small>${esc(r.c)}${visites[r.id] && visites[r.id].reservePar && sv === 'reserve' ? ' · ' + esc(visites[r.id].reservePar) : ''}</small></div><span>${d != null ? fmtDist(d) + ' ' + cap(maPos, r) : ''}</span></li>`;
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

  function telecharger(nom, contenu, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([contenu], { type }));
    a.download = nom; document.body.appendChild(a); a.click(); a.remove();
  }

  const lien = (ps) => ps.map(p => `${p.auteur || '?'} ${fmtDate(p.date)}`).join(' | ');
  function lignesExport() {
    return REPERES.map(r => {
      const v = visites[r.id] || {};
      return {
        id: r.id, type: r.t, nom: r.n, commune: r.c, etat_ign: r.e, fiche_ign: r.u,
        statut: v.statut === 'fait' ? 'visite_terminee' : (v.statut === 'reserve' ? 'reserve' : 'a_faire'),
        etat_constate: ETAT_LIB[v.etat] || '', commentaire: v.commentaire || '',
        visite_par: v.visitePar || '', date_visite: v.visiteLe || '',
        gps_visite_lat: v.gps ? v.gps.lat : '', gps_visite_lon: v.gps ? v.gps.lon : '', gps_precision_m: v.gps ? v.gps.acc : '',
        ecart_gps_ign_m: v.gps ? Math.round(distance(v.gps, r)) : '',
        journal: (v.journal || []).map(h => `${fmtDate(h.le)} ${h.par} : ${h.action}`).join(' | '),
        nb_photos: (v.photos || []).length,
        photo_pres: lien((v.photos || []).filter(p => p.role === 'pres')),
        photo_loin: lien((v.photos || []).filter(p => p.role === 'loin')),
        autres_photos: lien((v.photos || []).filter(p => !p.role || p.role === 'autre')),
        lat: r.lat, lon: r.lon
      };
    });
  }

  function initUI() {
    document.querySelectorAll('[data-ferme]').forEach(b => b.onclick = () => {
      $('#' + b.dataset.ferme).hidden = true;
      if (b.dataset.ferme === 'fiche') ouvert = null;
    });
    $('#btn-liste').onclick = () => { $('#liste').dataset.mode = ''; $('#fiche').hidden = true; ouvert = null; $('#menu').hidden = true; $('#liste').hidden = false; remplirListe(); };
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
    $('#btn-mes-reserves').onclick = () => { $('#menu').hidden = true; $('#liste').dataset.mode = 'mes'; $('#liste').hidden = false; remplirListe(); };
    $('#btn-mail').onclick = () => envoyerParMail(false);
    $('#btn-importer').onclick = () => $('#input-import').click();
    $('#input-import').onchange = (e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) importerFichiers(f); };
    $('#btn-envoyer').onclick =() => { if (!navigator.onLine) { toast('Pas de réseau pour l\'instant'); return; } S.envoyerFile(); toast('Envoi relancé'); };
    $('#btn-liberer').onclick = async () => {
      if (!confirm('Retirer de ce téléphone les photos déjà partagées ?\n\nÀ ne faire que si elles sont bien arrivées au bureau : les prochains fichiers partagés depuis ce téléphone ne les contiendront plus.')) return;
      const n = await S.libererPlace(); majEnvoi(); if (ouvert) afficherFiche(ouvert); toast(n + ' photo(s) retirée(s) du téléphone');
    };
    $('#btn-menu').addEventListener('click', majEnvoi);
    $('#btn-deconnexion').onclick =() => { $('#menu').hidden = true; S.deconnexion(); };

    const stamp = () => new Date().toISOString().slice(0, 10);
    $('#btn-export-geojson').onclick = () => {
      const fc = { type: 'FeatureCollection', name: 'reperes_ign_lot2', features: lignesExport().map(p => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: p })) };
      telecharger(`reperes_ign_lot2_${stamp()}.geojson`, JSON.stringify(fc, null, 1), 'application/geo+json');
    };
    $('#btn-export-csv').onclick = () => {
      const L_ = lignesExport(); const cols = Object.keys(L_[0]);
      const cell = (x) => { const s = String(x == null ? '' : x); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const csv = '﻿' + [cols.join(';')].concat(L_.map(l => cols.map(c => cell(l[c])).join(';'))).join('\r\n');
      telecharger(`reperes_ign_lot2_${stamp()}.csv`, csv, 'text/csv');
    };
  }
})();
