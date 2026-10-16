// Textes francais — espace « files ». Cles prefixees « files. ».
export default {
  // Colonne « Type » (facon Windows).
  "files.type.folder": "Dossier de fichiers",
  "files.type.ext": "Fichier {ext}",
  "files.type.file": "Fichier",

  // Nom propose quand un nom nettoye ne garde plus rien.
  "files.untitled": "sans-nom",

  // Validation d'un nom (renommer, nouveau dossier).
  "files.name.empty": "Le nom ne peut pas être vide.",
  "files.name.badChars": "Un nom ne peut pas contenir {chars}",
  "files.name.reserved": "Nom réservé.",

  // Erreurs de connexion rclone/SSH rendues lisibles.
  "files.err.hostKeyMismatch":
    "L'identité du serveur ne correspond pas à celle mémorisée : connexion refusée par sécurité. Reconnectez-vous pour voir l'empreinte présentée.",
  "files.err.macLocalNetwork":
    "Serveur injoignable depuis ce Mac : vérifiez que le VPN est connecté et que le serveur (ou son VPN) est bien démarré. Si le serveur répond par ailleurs, macOS bloque peut-être Copiteur : Réglages Système > Confidentialité et sécurité > Réseau local, activez Copiteur.",
  "files.err.hostKeyUnverified":
    "Identité du serveur non vérifiée : reconnectez-vous et acceptez son empreinte.",
  "files.err.tooManyAuth":
    "Trop de tentatives d'authentification, le serveur a coupé. Réessayez dans un instant (souvent l'agent SSH qui propose des clés avant le mot de passe).",
  "files.err.badLogin":
    "Identifiant ou mot de passe refusé par le serveur. Vérifiez aussi la casse de l'identifiant (« Alice » ≠ « alice »).",
  "files.err.unreachable":
    "Serveur injoignable : vérifiez l'adresse, le port, et que le serveur est bien allumé et accessible.",

  // Liste des serveurs memorises.
  "files.servers.placeholder": "Serveurs mémorisés…",
  "files.servers.empty": "Aucun serveur mémorisé",
  "files.servers.rename": "Renommer ce serveur",
  "files.servers.forget": "Oublier ce serveur",
};
