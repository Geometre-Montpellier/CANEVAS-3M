// Couche de stockage – tout dans Firebase Firestore (offre gratuite, sans carte bancaire).
//  - collection "visites" : un document par repère (statut, état, commentaire, liste des photos)
//      { statut: 'reserve'|'fait', etat, commentaire, reservePar, reserveLe, visitePar, visiteLe,
//        gps:{lat,lon,acc}, photos:[{cle,role,date,auteur,gps}], maj, majPar }
//  - collection "photos"  : un document par photo { repere, cle, role, date, auteur, gps, data (JPEG en base64) }
//    Les photos sont réduites (1600 px) pour tenir sous la limite de 1 Mo par document.
//  - Sur le téléphone (IndexedDB) : copie de chaque photo + file d'attente d'envoi.
//    Une photo prise sans réseau est envoyée automatiquement dès que le réseau revient.
//  - Mode démo (firebase-config.js vide) : visites dans localStorage, photos dans IndexedDB.
(function () {
  const cfg = window.FIREBASE_CONFIG || {};
  const DEMO = !cfg.apiKey;
  let db = null, auth = null, user = null;

  // ---------- IndexedDB : "blobs" {cle, blob} et "meta" {cle, id, role, date, auteur, gps, taille, envoye} ----------
  function idb() {
    return new Promise((ok, ko) => {
      const r = indexedDB.open('reperes-3m', 3);
      r.onupgradeneeded = () => {
        const b = r.result;
        if (b.objectStoreNames.contains('photos-attente')) b.deleteObjectStore('photos-attente');
        if (!b.objectStoreNames.contains('blobs')) b.createObjectStore('blobs', { keyPath: 'cle' });
        if (!b.objectStoreNames.contains('meta')) b.createObjectStore('meta', { keyPath: 'cle' });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
  }
  async function tx(stores, mode, fn) {
    const base = await idb();
    return new Promise((ok, ko) => {
      const t = base.transaction(stores, mode);
      const res = fn(...stores.map(s => t.objectStore(s)));
      t.oncomplete = () => ok(res && res.result !== undefined ? res.result : res);
      t.onerror = () => ko(t.error);
      t.onabort = () => ko(t.error || new Error('Mémoire du téléphone pleine ?'));
    });
  }
  const metaToutes = () => tx(['meta'], 'readonly', m => m.getAll());
  const blobDe = (cle) => tx(['blobs'], 'readonly', b => b.get(cle)).then(o => o && o.blob);
  const majMeta = (o) => tx(['meta'], 'readwrite', m => m.put(o));

  const blobVersBase64 = (b) => new Promise(ok => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(b); });
  const base64VersUrl = (s) => 'data:image/jpeg;base64,' + s;

  // ---------- Mode démo ----------
  const LS = 'demo-visites';
  const demoLire = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } };
  const demoEcrire = (o) => localStorage.setItem(LS, JSON.stringify(o));
  let demoCb = null;
  const demoNotifier = () => demoCb && demoCb(demoLire());
  const journaliser = (v, ligne) => { (v.journal = v.journal || []).push(ligne); };

  // Fusion de deux versions d'une même visite (a = ici, v = reçue) :
  // photos et journal réunis sans doublon ; pour les autres champs, la saisie la plus récente gagne.
  function fusionner(a, v) {
    const photos = [...(a.photos || [])];
    for (const p of (v.photos || [])) if (!photos.some(x => x.cle === p.cle)) photos.push(p);
    const plusRecente = String(v.maj || '') > String(a.maj || '');
    const journal = [...(a.journal || [])];
    for (const h of (v.journal || [])) if (!journal.some(x => x.le === h.le && x.action === h.action && x.par === h.par)) journal.push(h);
    journal.sort((x, y) => String(x.le).localeCompare(String(y.le)));
    const pointages = Object.assign({}, plusRecente ? a.pointages : v.pointages, plusRecente ? v.pointages : a.pointages);
    for (const c of Object.keys(pointages)) if (!photos.some(p => p.cle === c)) delete pointages[c];
    const archivees = Array.from(new Set([...(a.clesArchivees || []), ...(v.clesArchivees || [])]));
    return Object.assign({}, plusRecente ? a : v, plusRecente ? v : a, { photos }, archivees.length ? { clesArchivees: archivees } : {},
      journal.length ? { journal } : {}, Object.keys(pointages).length ? { pointages } : {});
  }

  const S = {
    demo: DEMO,
    get user() { return user; },
    onFileChange: null,   // appelé quand la file d'envoi change

    init() {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      if (DEMO) return;
      firebase.initializeApp(cfg);
      auth = firebase.auth();
      db = firebase.firestore();
      db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
      window.addEventListener('online', () => S.envoyerFile());
      setInterval(() => S.envoyerFile(), 60000);   // nouvel essai chaque minute
    },

    onAuth(cb) {
      if (DEMO) {
        const e = localStorage.getItem('demo-user');
        user = e ? { email: e, uid: 'demo' } : null;
        S._demoAuthCb = cb;
        setTimeout(() => cb(user), 0);
        return;
      }
      auth.onAuthStateChanged(u => { user = u; cb(u); if (u) S.envoyerFile(); });
    },

    async connexion(email, mdp) {
      if (DEMO) { localStorage.setItem('demo-user', email); user = { email, uid: 'demo' }; S._demoAuthCb(user); return; }
      await auth.signInWithEmailAndPassword(email, mdp);
    },

    async deconnexion() {
      if (DEMO) { localStorage.removeItem('demo-user'); user = null; S._demoAuthCb(null); return; }
      await auth.signOut();
    },

    ecouter(cb) {
      if (DEMO) { demoCb = cb; demoNotifier(); return () => { demoCb = null; }; }
      let premier = true;
      return db.collection('visites').onSnapshot(snap => {
        const o = {}; snap.forEach(d => { o[d.id] = d.data(); }); S._visitesCourantes = o; cb(o);
        if (premier && !snap.metadata.fromCache) {
          premier = false;
          S.migrerLocal(o).then(n => { if (n && S.onMigre) S.onMigre(n); }).catch(e => console.warn('migration', e));
        }
      }, err => { console.error(err); alert('Lecture des données impossible : ' + err.message); });
    },

    // Sans réseau, Firestore garde l'écriture et l'envoie au retour du réseau : on n'attend pas le serveur.
    // Chaque modification d'un repère est ajoutée à son journal : { le, par, action, ...détails }.
    // action : texte lisible (« État : Endommagé », « Visite terminée »…) ; à défaut, la liste des champs modifiés.
    async maj(id, patch, action, details) {
      const le = new Date().toISOString();
      const ligne = Object.assign({ le, par: S.nom(), action: action || ('Modification : ' + Object.keys(patch).join(', ')) }, details || {}, S.trace());
      const p = Object.assign({}, patch, { majPar: ligne.par, majAppareil: ligne.appareil, maj: le });
      if (DEMO) { const o = demoLire(); o[id] = Object.assign(o[id] || {}, p); journaliser(o[id], ligne); demoEcrire(o); demoNotifier(); return; }
      p.journal = firebase.firestore.FieldValue.arrayUnion(ligne);
      db.collection('visites').doc(id).set(p, { merge: true }).catch(e => alert('Enregistrement refusé : ' + e.message));
    },

    async effacerChamps(id, champs, action) {
      const le = new Date().toISOString();
      const ligne = Object.assign({ le, par: S.nom(), action: action || ('Effacé : ' + champs.join(', ')) }, S.trace());
      if (DEMO) { const o = demoLire(); o[id] = o[id] || {}; champs.forEach(c => delete o[id][c]); o[id].maj = le; o[id].majPar = ligne.par; journaliser(o[id], ligne); demoEcrire(o); demoNotifier(); return; }
      const p = { maj: le, majPar: ligne.par, journal: firebase.firestore.FieldValue.arrayUnion(ligne) };
      champs.forEach(c => p[c] = firebase.firestore.FieldValue.delete());
      db.collection('visites').doc(id).set(p, { merge: true }).catch(e => alert('Enregistrement refusé : ' + e.message));
    },

    // Photo : copie sur le téléphone + déclaration dans la visite, puis envoi (immédiat ou différé).
    async ajouterPhoto(id, blob, meta) {
      const cle = id + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const desc = Object.assign({ cle, role: meta.role || 'autre', date: new Date().toISOString(), auteur: S.nom() }, S.trace());
      // Traçabilité de la prise de vue (champs présents seulement s'ils sont connus)
      for (const k of ['gps', 'ecart', 'gpsPhoto', 'ecartPhoto', 'datePhoto']) if (meta[k] != null) desc[k] = meta[k];
      if (desc.gps) for (const k of Object.keys(desc.gps)) if (desc.gps[k] == null) delete desc.gps[k];
      const NOMS = { pres: 'Photo de près', loin: 'Photo de loin', autre: 'Autre photo' };
      const ligne = Object.assign({ le: desc.date, par: desc.auteur, action: NOMS[desc.role] + ' ajoutée', photo: cle }, meta.ecart != null ? { ecart: meta.ecart } : {}, S.trace());
      await tx(['blobs', 'meta'], 'readwrite', (b, m) => {
        b.put({ cle, blob });
        m.put(Object.assign({ id, taille: blob.size, envoye: DEMO }, desc));
      });
      if (DEMO) {
        const o = demoLire(); o[id] = o[id] || {}; (o[id].photos = o[id].photos || []).push(desc);
        o[id].maj = desc.date; o[id].majPar = desc.auteur; journaliser(o[id], ligne); demoEcrire(o); demoNotifier(); return cle;
      }
      // La photo est tout de suite visible des collègues (description) ; l'image suit dès que possible.
      db.collection('visites').doc(id).set({
        photos: firebase.firestore.FieldValue.arrayUnion(desc), maj: desc.date, majPar: desc.auteur,
        journal: firebase.firestore.FieldValue.arrayUnion(ligne)
      }, { merge: true }).catch(e => console.warn(e));
      S.onFileChange && S.onFileChange();
      S.envoyerFile();
      return cle;
    },

    _envoi: false,
    async envoyerFile() {
      if (DEMO || S._envoi || !user || !navigator.onLine) return;
      S._envoi = true;
      try {
        const file = (await metaToutes()).filter(m => !m.envoye).sort((a, b) => a.date.localeCompare(b.date));
        for (const m of file) {
          const blob = await blobDe(m.cle);
          if (!blob) { m.envoye = true; await majMeta(m); continue; }
          const doc = { repere: m.id, cle: m.cle, role: m.role, date: m.date, auteur: m.auteur, data: await blobVersBase64(blob) };
          for (const k of ['gps', 'ecart', 'gpsPhoto', 'ecartPhoto', 'datePhoto', 'appareil', 'modele']) if (m[k] != null) doc[k] = m[k];
          try {
            // On attend la confirmation du serveur (délai max 2 min) avant de marquer la photo comme envoyée
            await Promise.race([
              db.collection('photos').doc(m.cle).set(doc),
              new Promise((_, ko) => setTimeout(() => ko(new Error('délai dépassé')), 120000))
            ]);
            m.envoye = true; await majMeta(m);
            S.onFileChange && S.onFileChange();
          } catch (e) {
            // Photo d'une visite archivée déjà présente sur le serveur : elle est protégée (réécriture refusée), rien à renvoyer
            if (e && e.code === 'permission-denied') { m.envoye = true; await majMeta(m); continue; }
            console.warn('Envoi photo reporté', e); break;
          }
        }
      } finally { S._envoi = false; S.onFileChange && S.onFileChange(); }
    },

    async supprimerPhoto(id, desc) {
      // Photo d'une visite terminée archivée : elle sort de la fiche en cours mais reste conservée
      // (sur le serveur, et sur ce téléphone tant qu'elle n'a pas été envoyée).
      const archivee = S.estArchivee(id, desc.cle);
      const meta = await tx(['meta'], 'readonly', m => m.get(desc.cle)).catch(() => null);
      const effacerIci = !archivee || (!DEMO && meta && meta.envoye);
      if (effacerIci) {
        await tx(['blobs', 'meta'], 'readwrite', (b, m) => { b.delete(desc.cle); m.delete(desc.cle); });
        if (S._urls[desc.cle]) delete S._urls[desc.cle];
      }
      const NOMS = { pres: 'Photo de près', loin: 'Photo de loin', autre: 'Autre photo' };
      const ligne = Object.assign({ le: new Date().toISOString(), par: S.nom(), action: NOMS[desc.role || 'autre'] + (archivee ? ' retirée de la fiche (conservée dans la visite archivée)' : ' supprimée'), photo: desc.cle }, S.trace());
      if (DEMO) {
        const o = demoLire(); o[id] = o[id] || {};
        if (o[id].photos) o[id].photos = o[id].photos.filter(x => x.cle !== desc.cle);
        if (o[id].pointages) delete o[id].pointages[desc.cle];
        o[id].maj = ligne.le; o[id].majPar = ligne.par; journaliser(o[id], ligne);
        demoEcrire(o); demoNotifier(); return;
      }
      const batch = db.batch();
      if (!archivee) batch.delete(db.collection('photos').doc(desc.cle));
      batch.set(db.collection('visites').doc(id), {
        photos: firebase.firestore.FieldValue.arrayRemove(desc), maj: ligne.le, majPar: ligne.par,
        journal: firebase.firestore.FieldValue.arrayUnion(ligne),
        pointages: { [desc.cle]: firebase.firestore.FieldValue.delete() }
      }, { merge: true });
      batch.commit().catch(e => alert('Suppression refusée : ' + e.message));
    },

    // URL d'affichage : copie locale si elle existe, sinon téléchargement depuis Firestore (null si pas encore envoyée)
    _urls: {},
    async urlPhoto(cle) {
      if (S._urls[cle]) return S._urls[cle];
      const b = await blobDe(cle).catch(() => null);
      if (b) return (S._urls[cle] = URL.createObjectURL(b));
      if (DEMO) return null;
      try {
        const d = await db.collection('photos').doc(cle).get();
        if (d.exists && d.data().data) return (S._urls[cle] = base64VersUrl(d.data().data));
      } catch (e) { console.warn(e); }
      return null;
    },

    async photosLocales() { try { return await metaToutes(); } catch (e) { return []; } },

    // ---------- Archives des visites terminées (copies figées, jamais modifiées ni supprimées) ----------
    // Firebase : collection "visites_terminees" (une copie par « Visite terminée » cochée) et
    // "archives_cles" (un marqueur par photo d'une visite archivée : les règles interdisent alors
    // de supprimer ou de réécrire cette photo). La visite en cours garde la liste clesArchivees.
    estArchivee(id, cle) {
      const v = DEMO ? demoLire()[id] : (S._visitesCourantes || {})[id];
      return !!(v && (v.clesArchivees || []).includes(cle));
    },

    async archiverVisite(id, v) {
      const le = new Date().toISOString();
      const photos = (v.photos || []).map(p => Object.assign({}, p));
      const cles = photos.map(p => p.cle);
      const pointages = {};
      for (const c of cles) if (v.pointages && v.pointages[c]) pointages[c] = v.pointages[c];
      const copie = Object.assign({}, v, { repere: id, photos, pointages, archiveLe: le, archivePar: S.nom(), archiveAppareil: S.appareil(), archiveModele: S.modele() });
      delete copie.clesArchivees; delete copie.journal;
      if (DEMO) {
        const a = JSON.parse(localStorage.getItem('demo-archives') || '[]'); a.push(copie); localStorage.setItem('demo-archives', JSON.stringify(a));
        const o = demoLire(); o[id] = o[id] || {}; o[id].clesArchivees = Array.from(new Set([...(o[id].clesArchivees || []), ...cles])); demoEcrire(o); demoNotifier();
        return;
      }
      const batch = db.batch();
      batch.set(db.collection('visites_terminees').doc(), copie);
      for (const c of cles) batch.set(db.collection('archives_cles').doc(c), { repere: id, le });
      if (cles.length) batch.set(db.collection('visites').doc(id), { clesArchivees: firebase.firestore.FieldValue.arrayUnion(...cles) }, { merge: true });
      // Hors réseau, Firestore garde l'écriture et l'envoie au retour du réseau
      batch.commit().catch(e => alert('Archivage de la visite refusé : ' + e.message));
    },

    async archivesDe(id) {
      if (DEMO) return JSON.parse(localStorage.getItem('demo-archives') || '[]').filter(a => a.repere === id).sort((a, b) => b.archiveLe.localeCompare(a.archiveLe));
      try {
        const snap = await db.collection('visites_terminees').where('repere', '==', id).get();
        return snap.docs.map(d => d.data()).sort((a, b) => String(b.archiveLe).localeCompare(String(a.archiveLe)));
      } catch (e) { console.warn(e); return null; }
    },

    // Passage du mode local à Firebase : les relevés déjà faits sur ce téléphone (mode local) sont envoyés une fois.
    async migrerLocal(enLigne) {
      if (DEMO || localStorage.getItem('migre-firebase')) return 0;
      const locales = demoLire();
      let n = 0;
      for (const [id, v] of Object.entries(locales)) {
        const a = enLigne[id] || {};
        const fusion = fusionner(a, v);
        if (JSON.stringify(fusion) === JSON.stringify(a)) continue;
        db.collection('visites').doc(id).set(fusion, { merge: true }).catch(e => console.warn(e));
        n++;
      }
      const metas = await metaToutes();
      await tx(['meta'], 'readwrite', (m) => { metas.forEach(o => { if (o.envoye) { o.envoye = false; m.put(o); } }); });
      localStorage.setItem('migre-firebase', new Date().toISOString());
      S.envoyerFile();
      return n;
    },

    // Supprime du téléphone les copies des photos déjà envoyées à Firebase (elles restent consultables en ligne)
    async libererPlace() {
      const envoyees = (await metaToutes()).filter(m => m.envoye && !DEMO);
      await tx(['blobs', 'meta'], 'readwrite', (b, m) => { envoyees.forEach(x => { b.delete(x.cle); m.delete(x.cle); }); });
      envoyees.forEach(x => { if (S._urls[x.cle] && S._urls[x.cle].startsWith('blob:')) { URL.revokeObjectURL(S._urls[x.cle]); delete S._urls[x.cle]; } });
      return envoyees.length;
    },

    nom() {
      return localStorage.getItem('nom-terrain') || (user && user.email ? user.email.split('@')[0] : 'inconnu');
    },

    // Identifiant du téléphone (traçabilité, jamais affiché) : tiré au hasard à la première ouverture et
    // conservé ensuite. Il ne dépend pas du prénom saisi : il permet de savoir après coup quel appareil
    // a fait quoi, même si quelqu'un se déclare sous le prénom d'un collègue.
    appareil() {
      let a = null;
      try { a = localStorage.getItem('id-appareil'); } catch (e) {}
      if (!a) {
        const h = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16) + Math.random().toString(16).slice(2)).replace(/-/g, '');
        a = h.slice(0, 8).toUpperCase();
        try { localStorage.setItem('id-appareil', a); localStorage.setItem('id-appareil-cree', new Date().toISOString()); } catch (e) {}
      }
      return a;
    },
    // Modèle du téléphone, lu une fois (Chrome Android donne le modèle exact, iPhone seulement la version d'iOS)
    modele() {
      try { return localStorage.getItem('modele-appareil') || modeleUA(); } catch (e) { return modeleUA(); }
    },
    // Champs ajoutés à chaque écriture
    trace() { return { appareil: S.appareil(), modele: S.modele() }; }
  };
  function modeleUA() {
    const ua = navigator.userAgent;
    let m = ua.match(/Android [\d.]+(?:; ([^;)]+))?/);
    if (m) return (m[1] && m[1] !== 'K' ? m[1] + ', ' : '') + m[0].split(';')[0];
    m = ua.match(/(iPhone|iPad).*?OS ([\d_]+)/);
    if (m) return m[1] + ', iOS ' + m[2].replace(/_/g, '.');
    return (navigator.platform || 'appareil inconnu');
  }
  (async () => {
    try {
      S.appareil();
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const v = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion']);
        const pf = navigator.userAgentData.platform || '';
        const lib = [v.model, pf + (v.platformVersion ? ' ' + v.platformVersion.split('.')[0] : '')].filter(Boolean).join(', ');
        if (lib) localStorage.setItem('modele-appareil', lib);
      }
    } catch (e) {}
  })();
  window.Stockage = S;
})();
