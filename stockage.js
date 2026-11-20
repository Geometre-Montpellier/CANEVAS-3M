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
    return Object.assign({}, plusRecente ? a : v, plusRecente ? v : a, { photos },
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
      const ligne = Object.assign({ le, par: S.nom(), action: action || ('Modification : ' + Object.keys(patch).join(', ')) }, details || {});
      const p = Object.assign({}, patch, { majPar: ligne.par, maj: le });
      if (DEMO) { const o = demoLire(); o[id] = Object.assign(o[id] || {}, p); journaliser(o[id], ligne); demoEcrire(o); demoNotifier(); return; }
      p.journal = firebase.firestore.FieldValue.arrayUnion(ligne);
      db.collection('visites').doc(id).set(p, { merge: true }).catch(e => alert('Enregistrement refusé : ' + e.message));
    },

    async effacerChamps(id, champs, action) {
      const le = new Date().toISOString();
      const ligne = { le, par: S.nom(), action: action || ('Effacé : ' + champs.join(', ')) };
      if (DEMO) { const o = demoLire(); o[id] = o[id] || {}; champs.forEach(c => delete o[id][c]); o[id].maj = le; o[id].majPar = ligne.par; journaliser(o[id], ligne); demoEcrire(o); demoNotifier(); return; }
      const p = { maj: le, majPar: ligne.par, journal: firebase.firestore.FieldValue.arrayUnion(ligne) };
      champs.forEach(c => p[c] = firebase.firestore.FieldValue.delete());
      db.collection('visites').doc(id).set(p, { merge: true }).catch(e => alert('Enregistrement refusé : ' + e.message));
    },

    // Photo : copie sur le téléphone + déclaration dans la visite, puis envoi (immédiat ou différé).
    async ajouterPhoto(id, blob, meta) {
      const cle = id + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const desc = { cle, role: meta.role || 'autre', date: new Date().toISOString(), auteur: S.nom() };
      if (meta.gps) desc.gps = meta.gps;
      const NOMS = { pres: 'Photo de près', loin: 'Photo de loin', autre: 'Autre photo' };
      const ligne = Object.assign({ le: desc.date, par: desc.auteur, action: NOMS[desc.role] + ' ajoutée', photo: cle }, meta.ecart != null ? { ecart: meta.ecart } : {});
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
          if (m.gps) doc.gps = m.gps;
          try {
            // On attend la confirmation du serveur (délai max 2 min) avant de marquer la photo comme envoyée
            await Promise.race([
              db.collection('photos').doc(m.cle).set(doc),
              new Promise((_, ko) => setTimeout(() => ko(new Error('délai dépassé')), 120000))
            ]);
            m.envoye = true; await majMeta(m);
            S.onFileChange && S.onFileChange();
          } catch (e) { console.warn('Envoi photo reporté', e); break; }
        }
      } finally { S._envoi = false; S.onFileChange && S.onFileChange(); }
    },

    async supprimerPhoto(id, desc) {
      await tx(['blobs', 'meta'], 'readwrite', (b, m) => { b.delete(desc.cle); m.delete(desc.cle); });
      if (S._urls[desc.cle]) delete S._urls[desc.cle];
      const NOMS = { pres: 'Photo de près', loin: 'Photo de loin', autre: 'Autre photo' };
      const ligne = { le: new Date().toISOString(), par: S.nom(), action: NOMS[desc.role || 'autre'] + ' supprimée', photo: desc.cle };
      if (DEMO) {
        const o = demoLire(); o[id] = o[id] || {};
        if (o[id].photos) o[id].photos = o[id].photos.filter(x => x.cle !== desc.cle);
        if (o[id].pointages) delete o[id].pointages[desc.cle];
        o[id].maj = ligne.le; o[id].majPar = ligne.par; journaliser(o[id], ligne);
        demoEcrire(o); demoNotifier(); return;
      }
      const batch = db.batch();
      batch.delete(db.collection('photos').doc(desc.cle));
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
    }
  };
  window.Stockage = S;
})();
