// Textes francais — espace « pane » (panneau explorateur, FilePane.tsx).
// Cles prefixees « pane. ».
export default {
  // Colonnes de la vue liste.
  "pane.col.name": "Nom",
  "pane.col.date": "Modifié le",
  "pane.col.type": "Type",
  "pane.col.size": "Taille",

  // Volet de navigation (arbre).
  "pane.tree.quickAccess": "Accès rapide",
  "pane.tree.thisPc": "Ce PC",

  // En-tete : navigation, adresse, recherche, vue.
  "pane.head.back": "Précédent",
  "pane.head.forward": "Suivant",
  "pane.head.up": "Remonter",
  "pane.head.refresh": "Rafraîchir",
  "pane.head.pathOf": "Chemin {title}",
  "pane.head.typePath": "Cliquer pour saisir un chemin",
  "pane.head.parents": "Dossiers parents",
  "pane.head.loading": "Chargement…",
  "pane.head.pathChoices": "Ce chemin existe à plusieurs endroits :",
  "pane.head.searchHere": "Rechercher ici…",
  "pane.head.searchIn": "Rechercher dans {title}",
  "pane.head.clear": "Effacer",
  "pane.head.search": "Rechercher",
  "pane.head.listView": "Vue liste",
  "pane.head.tilesView": "Vue miniatures",

  // Zone des fichiers.
  "pane.list.stale": "Liste non actualisée : {err}",
  "pane.list.notConnected": "Non connecté",
  "pane.list.noResult": "Aucun résultat pour « {query} »",
  "pane.list.emptyHidden": "Dossier vide (contenu masqué)",
  "pane.list.empty": "Dossier vide",

  // Barre d'etat.
  "pane.status.items_one": "{n} élément",
  "pane.status.items_other": "{n} éléments",
  "pane.status.selected_one": "{n} sélectionné",
  "pane.status.selected_other": "{n} sélectionnés",

  // Compteurs.
  "pane.count.files_one": "{n} fichier",
  "pane.count.files_other": "{n} fichiers",
  "pane.count.dirs_one": "{n} dossier",
  "pane.count.dirs_other": "{n} dossiers",
  "pane.count.items_one": "{n} élément",
  "pane.count.items_other": "{n} éléments",

  // Menu contextuel.
  "pane.ctx.pin": "Épingler à l'accès rapide",
  "pane.ctx.unpin": "Désépingler de l'accès rapide",
  "pane.ctx.sizeComputing": "Calcul de la taille…",
  "pane.ctx.sizeUnavailable": "Taille indisponible",
  "pane.ctx.newFolder": "Nouveau dossier",
  "pane.ctx.open": "Ouvrir",
  "pane.ctx.openWith": "Ouvrir avec…",
  "pane.ctx.reveal": "Ouvrir dans l'explorateur",
  "pane.ctx.copy": "Copier",
  "pane.ctx.paste": "Coller",
  "pane.ctx.renameOne": "Sélectionne un seul élément pour le renommer",
  "pane.ctx.startHere": "Démarrer ici",
  "pane.ctx.startHereOff": "Ne plus démarrer ici",
  "pane.ctx.startHereHint": "Ouvrir ce serveur directement sur ce dossier à chaque connexion",
  "pane.ctx.startHereOffHint": "Ne plus ouvrir ce serveur sur ce dossier au démarrage",
  "pane.ctx.refresh": "Actualiser",

  // Nom donne au dossier cree (puis renomme sur place).
  "pane.newFolderName": "Nouveau dossier",

  // Erreurs d'operation (bandeau rouge).
  "pane.err.create": "Création impossible : {err}",
  "pane.err.exists": "« {name} » existe déjà dans ce dossier.",
  "pane.err.rename": "Renommage impossible : {err}",
  "pane.err.move": "Déplacement impossible : {err}",
  "pane.err.pathNotFound": "Chemin introuvable de ce côté : {path}",

  // Confirmation de suppression. {what} = « 3 fichiers » en gras.
  "pane.del.title": "Confirmation requise",
  "pane.del.askLocal": "Voulez-vous vraiment supprimer {what} de « Ton PC » ?",
  "pane.del.askRemote": "Voulez-vous vraiment supprimer {what} du serveur ?",
  "pane.del.computing": "Calcul du contenu…",
  "pane.del.atLeast": "au moins {what}",
  "pane.del.permanent": " — suppression définitive",
  "pane.del.no": "Non",
  "pane.del.yes": "Oui, supprimer",

  // Journal. {path} = « Ton PC /dossier/nom ».
  "pane.log.deleted": "Suppression définitive : {path}",
  "pane.log.deleteFailed": "Suppression impossible : {path} — {err}",
  "pane.log.newFolder": "Nouveau dossier : {path}",
  "pane.log.createFailed": "Création impossible : {path} — {err}",
  "pane.log.renamed": "Renommé : {path} → {name}",
  "pane.log.renameFailed": "Renommage impossible : {path} → {name} — {err}",
  "pane.log.moved": "Déplacé : {path} → {dest}",
  "pane.log.moveFailed": "Déplacement impossible : {path} → {dest} — {err}",
};
