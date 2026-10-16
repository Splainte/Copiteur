// Textes francais — espace « app ». Cles prefixees « app. ».
export default {
  // Barre de titre (Windows/Linux)
  "app.win.minimize": "Réduire",
  "app.win.maximize": "Agrandir",
  "app.win.close": "Fermer",

  // Barre de connexion
  "app.conn.name": "Nom (facultatif)",
  "app.conn.host": "Hôte",
  "app.conn.user": "Utilisateur",
  "app.conn.password": "Mot de passe",
  "app.conn.port": "Port",
  "app.conn.connect": "Se connecter",
  "app.conn.connecting": "Connexion…",
  "app.conn.journal": "Journal",
  "app.conn.journalTitle": "Journal (diagnostic)",
  "app.conn.settings": "Paramètres",
  "app.conn.hostKeyRefused": "Connexion annulée : identité du serveur non acceptée.",
  "app.conn.timeout": "Le serveur ne répond pas (délai dépassé).",

  // Moteur rclone
  "app.rclone.unreachable": "rclone injoignable",
  "app.rclone.starting": "démarrage de rclone…",
  "app.rclone.custom": "Moteur rclone custom",

  // Erreurs de transfert
  "app.err.nameRefused": "Nom refusé par la destination (« {name} ») — {err}",
  "app.err.hashRetry":
    "Le serveur n'a pas su fournir d'empreinte vérifiable — nouvelle tentative sans vérification par empreinte. ({err})",
  "app.err.streamFallback":
    "Le serveur a refusé {from} connexions simultanées en envoi — nouvelle tentative avec {to}. ({err})",

  // Dialogue : fichier deja present
  "app.conflict.title": "Le fichier existe déjà",
  "app.conflict.body": "« {name} » est déjà présent dans le dossier de destination. Que faire ?",
  "app.conflict.applyAll": "Appliquer à tous les fichiers de cette copie",
  "app.conflict.skip": "Ignorer",
  "app.conflict.replace": "Remplacer",

  // Dialogue : nom refuse
  "app.rename.title": "Nom refusé par la destination",
  "app.rename.body":
    "« {name} » n'a pas pu être copié : la destination n'accepte pas certains caractères de ce nom ({chars}).",
  "app.rename.ask": "Copier sous le nom « {name} » ?",
  "app.rename.applyAll": "Appliquer aux autres noms refusés de cette copie",
  "app.rename.drop": "Laisser tomber",
  "app.rename.confirm": "Renommer et copier",

  // Dialogue : fermeture avec du travail en cours
  "app.close.titleXfers": "Des transferts sont en cours",
  "app.close.titleEdits": "Des éditions ne sont pas renvoyées",
  "app.close.xfers_one": "{n} transfert en cours ou en attente.",
  "app.close.xfers_other": "{n} transferts en cours ou en attente.",
  "app.close.edits_one": "{n} fichier édité pas encore renvoyé sur le serveur.",
  "app.close.edits_other": "{n} fichiers édités pas encore renvoyés sur le serveur.",
  "app.close.lose": "Fermer maintenant perdra ces changements.",
  "app.close.force": "Fermer quand même",

  // Dialogue : identite du serveur
  "app.hostkey.titleChanged": "Attention : l'identité du serveur a changé",
  "app.hostkey.titleNew": "Première connexion à ce serveur",
  "app.hostkey.changedBody":
    "La clé présentée par {server} ne correspond pas à celle mémorisée. C'est normal après une réinstallation ou une mise à jour du serveur, mais cela peut aussi signifier que quelqu'un se fait passer pour lui afin d'intercepter votre mot de passe.",
  "app.hostkey.stored": "Empreinte mémorisée",
  "app.hostkey.presented": "Empreinte présentée",
  "app.hostkey.changedHint":
    "Dans le doute, annulez et vérifiez auprès de la personne qui gère le serveur.",
  "app.hostkey.newBody": "Copiteur ne connaît pas encore {server}. Voici l'empreinte de sa clé d'identité :",
  "app.hostkey.newHint":
    "Si vous pouvez, comparez-la à celle donnée par la personne qui gère le serveur. Copiteur la mémorise et vous alertera si elle change un jour.",
  "app.hostkey.trustNew": "Faire confiance à la nouvelle clé",
  "app.hostkey.trust": "Faire confiance et se connecter",

  // Dialogue : app lancee depuis le .dmg (macOS)
  "app.dmg.title": "Installer Copiteur ?",
  "app.dmg.body":
    "Copiteur tourne actuellement depuis son image disque ({mount}), pas depuis le dossier Applications. Le déplacer évite qu'elle réapparaisse comme un volume dans le panneau de gauche, et l'éjecte automatiquement.",
  "app.dmg.stay": "Continuer depuis là",
  "app.dmg.moving": "Déplacement…",
  "app.dmg.move": "Déplacer vers Applications",

  // Dialogues : edition d'un fichier distant
  "app.edit.title": "Fichier modifié",
  "app.edit.body": "« {name} » a été modifié. Le renvoyer sur le serveur ?",
  "app.edit.ignore": "Ignorer",
  "app.edit.resend": "Renvoyer",
  "app.editConflict.title": "Conflit sur le serveur",
  "app.editConflict.deleted":
    "« {name} » n'existe plus sur le serveur (supprimé ou déplacé depuis que vous l'avez ouvert). Le renvoyer le recréera.",
  "app.editConflict.changed":
    "« {name} » a été modifié sur le serveur depuis que vous l'avez ouvert. Le renvoyer {overwrite} la version du serveur.",
  "app.editConflict.overwriteWord": "écrasera",
  "app.editConflict.overwrite": "Écraser",

  // Barre de transfert (bas de fenetre)
  "app.bar.lost_one":
    "Connexion perdue — reprise automatique · {n} transfert en attente · reste {size}",
  "app.bar.lost_other":
    "Connexion perdue — reprise automatique · {n} transferts en attente · reste {size}",
  "app.bar.stalled_one":
    "Plus aucune donnée ne passe — en attente du serveur · {n} transfert · reste {size}",
  "app.bar.stalled_other":
    "Plus aucune donnée ne passe — en attente du serveur · {n} transferts · reste {size}",
  "app.bar.progress_one": "{n} transfert · {pct}% · reste {size} · {speed}",
  "app.bar.progress_other": "{n} transferts · {pct}% · reste {size} · {speed}",
  "app.bar.etaSec": " · {s} s",
  "app.bar.etaMin": " · {m} min",
  "app.bar.error": "Erreur : {err}",
  "app.bar.idle": "Aucun transfert en cours",

  // Journal
  "app.log.rcloneRestarted": "Le moteur rclone a été relancé (il s'était arrêté)",
  "app.log.hostKeyRefused": "Connexion à {host} annulée — empreinte {kind} refusée ({fp})",
  "app.log.kindChanged": "CHANGÉE",
  "app.log.kindNew": "nouvelle",
  "app.log.keyAccepted": "Nouvelle clé acceptée pour {host} : {algo} {fp}",
  "app.log.keyStored": "Clé mémorisée pour {host} : {algo} {fp}",
  "app.log.connected": "Connecté à {target}",
  "app.log.connFailed": "Échec de connexion à {target} — {err}",
  "app.log.queued_one": "Mise en file : {n} élément → {dest} {dir}",
  "app.log.queued_other": "Mise en file : {n} éléments → {dest} {dir}",
  "app.log.openFailed": "Ouverture impossible : {name} — {err}",
  "app.log.editStarted": "Édition démarrée : {name}",
  "app.log.noHash":
    "Ce serveur ne sait pas calculer d'empreinte : vérification par empreinte désactivée (la taille reste vérifiée). Les transferts échoués sont relancés.",
  "app.log.renamedForCopy": "Renommé pour la copie : {from} → {to}",
  "app.log.opened": "Ouverture : {name}",
  "app.log.resent": "Renvoi après édition : {name}",
  "app.log.retry": "Coupure, reprise auto (tentative {n}) : {label} — {err}",
  "app.log.failed": "Échec : {label} — {err}",
  "app.log.cancelled": "Annulé : {label}",
  "app.log.batchDone": "Lot terminé : {done}, {failed}, {cancelled}",
  "app.log.batchOk_one": "{n} réussi",
  "app.log.batchOk_other": "{n} réussis",
  "app.log.batchFail_one": "{n} échec",
  "app.log.batchFail_other": "{n} échecs",
  "app.log.batchCancel_one": "{n} annulé",
  "app.log.batchCancel_other": "{n} annulés",
  "app.log.moveFailed": "Déplacement vers Applications impossible : {err}",
};
