// Configuration Firebase du projet canevas-3m (console Firebase > Paramètres du projet > Vos applications > Web).
// Ces identifiants sont publics par nature (ils désignent le projet) : l'accès aux données est protégé
// par la connexion (compte équipe) et par les règles Firestore (firestore.rules).
// Pour revenir au mode local (partage par fichier), vider apiKey.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDxPO5tJXd4i7-zZQHHq-ySzuDKxUevRRI",
  authDomain: "canevas-3m.firebaseapp.com",
  projectId: "canevas-3m",
  storageBucket: "canevas-3m.firebasestorage.app",
  messagingSenderId: "993249152721",
  appId: "1:993249152721:web:aa7ded734fd63f3042fff0"
};

// Compte partagé par toute l'équipe terrain : chacun saisit son prénom + le code équipe (mot de passe de ce compte).
window.COMPTE_EQUIPE = "equipe@canevas-3m.siragusa";
