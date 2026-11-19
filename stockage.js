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
      return db.collection('visites').onSnapshot(snap => {
        const o = {}; snap.forEach(d => { o[d.id] = d.data(); }); S._visitesCourantes = o; cb(o);
      }, err => { console.error(err); alert('Lecture des données impossible : ' + err.message); });
    },

    // Sans réseau, Firestore garde l'écriture et l'envoie au retour du réseau : on n'attend pas le serveur.
    async maj(id, patch) {
      const p = Object.assign({}, patch, { majPar: S.nom(), maj: new Date().toISOString() });
      if (DEMO) { const o = demoLire(); o[id] = Object.assign(o[id] || {}, p); demoEcrire(o); demoNotifier(); return; }
      db.collection('visites').doc(id).set(p, { merge: true }).catch(e => alert('Enregistrement refusé : ' + e.message));
    },

    async effacerChamps(id, champs) {
      if (DEMO) { const o = demoLire(); if (o[id]) champs.forEach(c => delete o[id][c]); demoEcrire(o); demoNotifier(); return; }
      const p = { maj: new Date().toISOString(), majPar: S.nom() };
      champs.forEach(c => p[c] = firebase.firestore.FieldValue.delete());
      db.collection('visites').doc(id).set(p, { merge: true }).catch(e => alert('Enregistrement refusé : ' + e.message));
    },

    // Photo : copie sur le téléphone + déclaration dans la visite, puis envoi (immédiat ou différé).
    async ajouterPhoto(id, blob, meta) {
      const cle = id + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const desc = { cle, role: meta.role || 'autre', date: new Date().toISOString(), auteur: S.nom() };
      if (meta.gps) desc.gps = meta.gps;
      await tx(['blobs', 'meta'], 'readwrite', (b, m) => {
        b.put({ cle, blob });
        m.put(Object.assign({ id, taille: blob.size, envoye: DEMO }, desc));
      });
      if (DEMO) {
        const o = demoLire(); o[id] = o[id] || {}; (o[id].photos = o[id].photos || []).push(desc);
        o[id].maj = desc.date; o[id].majPar = desc.auteur; demoEcrire(o); demoNotifier(); return;
      }
      // La photo est tout de suite visible des collègues (description) ; l'image suit dès que possible.
      db.collection('visites').doc(id).set({
        photos: firebase.firestore.FieldValue.arrayUnion(desc), maj: desc.date, majPar: desc.auteur
      }, { merge: true }).catch(e => console.warn(e));
      S.onFileChange && S.onFileChange();
      S.envoyerFile();
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
      if (DEMO) {
        const o = demoLire(); if (o[id] && o[id].photos) o[id].photos = o[id].photos.filter(x => x.cle !== desc.cle);
        demoEcrire(o); demoNotifier(); return;
      }
      const batch = db.batch();
      batch.delete(db.collection('photos').doc(desc.cle));
      batch.set(db.collection('visites').doc(id), {
        photos: firebase.firestore.FieldValue.arrayRemove(desc), maj: new Date().toISOString(), majPar: S.nom()
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

    // ---------- Envoi au bureau par mail (ZIP) ----------
    // Découpe en plusieurs ZIP de 18 Mo max (limite des pièces jointes Gmail / Outlook).
    // Chaque ZIP : Photos/<Commune>/<Repère> (<id>)/pres.jpg, loin.jpg, autre-….jpg + dechargement.json
    async construireZips(reperes, visites, toutes) {
      const MAX = 18 * 1024 * 1024;
      const parId = Object.fromEntries(reperes.map(r => [r.id, r]));
      // Tout ce que le téléphone possède, y compris les photos importées des collègues :
      // le dernier fichier de n'importe qui suffit à un nouvel arrivant pour avoir l'état complet.
      const metas = (await metaToutes()).filter(m => toutes || !m.exporte).sort((a, b) => a.date.localeCompare(b.date));
      const propre = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
      const lots = [[]]; let taille = 0;
      for (const m of metas) {
        if (!parId[m.id]) continue;
        if (taille + (m.taille || 0) > MAX && lots[lots.length - 1].length) { lots.push([]); taille = 0; }
        lots[lots.length - 1].push(m); taille += m.taille || 0;
      }
      // Même sans nouvelle photo, le fichier transporte l'état des visites (réservations, repères introuvables…)
      const resultat = [];
      for (let k = 0; k < lots.length; k++) {
        const fichiers = [], liste = [];
        for (const m of lots[k]) {
          const r = parId[m.id];
          const nom = m.role === 'autre' ? 'autre-' + m.date.replace(/[-:T]/g, '').slice(0, 14) + '.jpg' : m.role + '.jpg';
          const chemin = `Photos/${propre(r.c)}/${propre(r.n)} (${r.id})/${nom}`;
          const blob = await blobDe(m.cle);
          if (!blob) continue;
          fichiers.push({ chemin, blob, date: new Date(m.date) });
          liste.push({ cle: m.cle, id: m.id, role: m.role, date: m.date, auteur: m.auteur, gps: m.gps || null, fichier: chemin });
        }
        const manifeste = { app: 'reperes-3m-lot2', version: 1, auteur: S.nom(), compte: user && user.email,
          date: new Date().toISOString(), partie: k + 1, parties: lots.length, photos: liste, visites };
        fichiers.push({ chemin: 'dechargement.json', blob: new Blob([JSON.stringify(manifeste, null, 1)], { type: 'application/json' }), date: new Date() });
        resultat.push({ zip: await zipStocke(fichiers), cles: liste.map(p => p.cle) });
      }
      return resultat;
    },

    // Import du fichier d'un collègue : fusion des visites (la plus récente gagne, photos réunies)
    // et copie des photos sur ce téléphone. Retourne un bilan.
    async importerZip(fichier, avecPhotos) {
      const entrees = await lireZip(fichier);
      const man = entrees['dechargement.json'] ? JSON.parse(await entrees['dechargement.json'].text()) : null;
      if (!man || man.app !== 'reperes-3m-lot2') throw new Error('ce fichier ne vient pas de l\'appli Repères 3M');
      const locales = DEMO ? demoLire() : null;
      const actuelles = DEMO ? locales : (S._visitesCourantes || {});
      let nbVisites = 0, nbPhotos = 0;
      // 1. Visites
      for (const [id, v] of Object.entries(man.visites || {})) {
        const a = actuelles[id] || {};
        const photos = [...(a.photos || [])];
        for (const p of (v.photos || [])) if (!photos.some(x => x.cle === p.cle)) photos.push(p);
        // On complète ce qui manque ; si les deux ont renseigné un champ, la saisie la plus récente gagne.
        const plusRecente = String(v.maj || '') > String(a.maj || '');
        const fusion = Object.assign({}, plusRecente ? a : v, plusRecente ? v : a, { photos });
        if (JSON.stringify(fusion) === JSON.stringify(a)) continue;
        nbVisites++;
        if (DEMO) locales[id] = fusion;
        else db.collection('visites').doc(id).set(fusion, { merge: true }).catch(e => console.warn(e));
      }
      if (DEMO) { demoEcrire(locales); demoNotifier(); }
      // 2. Photos (copie locale, déjà « parties » : on ne les renvoie pas)
      if (avecPhotos) {
        const deja = new Set((await metaToutes()).map(m => m.cle));
        for (const p of (man.photos || [])) {
          if (deja.has(p.cle) || !entrees[p.fichier]) continue;
          const blob = new Blob([await entrees[p.fichier].arrayBuffer()], { type: 'image/jpeg' });
          await tx(['blobs', 'meta'], 'readwrite', (b, m) => {
            b.put({ cle: p.cle, blob });
            m.put({ cle: p.cle, id: p.id, role: p.role, date: p.date, auteur: p.auteur, gps: p.gps, taille: blob.size,
              envoye: true, exporte: new Date().toISOString(), importe: true });
          });
          nbPhotos++;
        }
      }
      return { auteur: man.auteur, date: man.date, nbVisites, nbPhotos, partie: man.partie, parties: man.parties };
    },

    async marquerExportees(cles) {
      const set = new Set(cles), quand = new Date().toISOString();
      const a = (await metaToutes()).filter(o => set.has(o.cle));
      await tx(['meta'], 'readwrite', (m) => { a.forEach(o => { o.exporte = quand; m.put(o); }); });
    },

    // Supprime du téléphone les copies des photos déjà parties (par Firebase ou par mail)
    async libererPlace() {
      const envoyees = (await metaToutes()).filter(m => (m.envoye && !DEMO) || m.exporte);
      await tx(['blobs', 'meta'], 'readwrite', (b, m) => { envoyees.forEach(x => { b.delete(x.cle); m.delete(x.cle); }); });
      envoyees.forEach(x => { if (S._urls[x.cle] && S._urls[x.cle].startsWith('blob:')) { URL.revokeObjectURL(S._urls[x.cle]); delete S._urls[x.cle]; } });
      return envoyees.length;
    },

    nom() {
      return localStorage.getItem('nom-terrain') || (user && user.email ? user.email.split('@')[0] : 'inconnu');
    }
  };
  // ---------- ZIP sans compression (les JPEG sont déjà compressés) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function zipStocke(fichiers) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const f of fichiers) {
      const nom = enc.encode(f.chemin);
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const crc = crc32(data), taille = data.length;
      const d = f.date, heure = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const jour = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(10, heure, true); lh.setUint16(12, jour, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, taille, true); lh.setUint32(22, taille, true); lh.setUint16(26, nom.length, true);
      parts.push(lh.buffer, nom, f.blob);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, heure, true); ch.setUint16(14, jour, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, taille, true); ch.setUint32(24, taille, true); ch.setUint16(28, nom.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, nom);
      offset += 30 + nom.length + taille;
    }
    const tailleCentral = central.reduce((s, p) => s + (p.byteLength || p.length), 0);
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, fichiers.length, true); fin.setUint16(10, fichiers.length, true);
    fin.setUint32(12, tailleCentral, true); fin.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [fin.buffer]), { type: 'application/zip' });
  }

  // Lecture d'un ZIP (entrées stockées, ou compressées « deflate » si une appli l'a recompressé)
  async function lireZip(fichier) {
    const buf = new Uint8Array(await fichier.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let fin = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { fin = i; break; }
    if (fin < 0) throw new Error('fichier ZIP illisible');
    const nb = dv.getUint16(fin + 10, true);
    let p = dv.getUint32(fin + 16, true);
    const dec = new TextDecoder();
    const res = {};
    for (let k = 0; k < nb; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP abîmé');
      const methode = dv.getUint16(p + 10, true), taille = dv.getUint32(p + 20, true);
      const ln = dv.getUint16(p + 28, true), lx = dv.getUint16(p + 30, true), lc = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const nom = dec.decode(buf.subarray(p + 46, p + 46 + ln));
      const debut = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const brut = buf.subarray(debut, debut + taille);
      if (methode === 0) res[nom] = new Blob([brut]);
      else if (methode === 8 && 'DecompressionStream' in window) res[nom] = await new Response(new Blob([brut]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      else throw new Error('format de compression non pris en charge');
      p += 46 + ln + lx + lc;
    }
    return res;
  }

  window.Stockage = S;
})();
