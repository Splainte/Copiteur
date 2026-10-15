# Copiteur

Client de transfert de fichiers SFTP en double explorateur, façon FileZilla, motorisé par
**[rclone](https://rclone.org)**. Pensé pour rapatrier de gros fichiers (rushes vidéo…) depuis
un NAS ou un serveur à pleine vitesse — y compris quand il ne reste qu'**un seul gros
fichier**, le cas où FileZilla plafonne.

Windows et macOS (Apple Silicon). Tauri v2 + React/TypeScript, rclone embarqué.

## Installer

Télécharger la dernière version dans les
[Releases](https://github.com/Splainte/Copiteur/releases/latest) :

- **Windows** : `Copiteur_x.y.z_x64-setup.exe`. L'installeur n'est pas signé : Windows
  SmartScreen affiche « Windows a protégé votre ordinateur » → *Informations
  complémentaires* → *Exécuter quand même*. Pas besoin de droits administrateur.
- **macOS** : `Copiteur_x.y.z_aarch64.dmg`, glisser l'app dans Applications. L'app n'est pas
  notariée par Apple : au premier lancement, clic droit sur l'app → *Ouvrir* → *Ouvrir*
  (ou Réglages Système → Confidentialité et sécurité → *Ouvrir quand même*).

Copiteur se met ensuite à jour tout seul : il vérifie au démarrage si une nouvelle version
existe et propose de l'installer. Chaque mise à jour est signée ; une mise à jour dont la
signature ne correspond pas est refusée.

## Ce que ça fait

**Transferts** — glisser-déposer entre les deux panneaux et Ctrl/Cmd+C · V, dans les deux sens.
Lâcher sur un dossier copie dedans. Un dossier déposé est éclaté en un transfert par fichier.
File d'attente à quatre onglets (attente / terminés / échoués / annulés), reprise automatique
sur coupure réseau, indicateur « figé » quand plus un octet ne passe.

**Navigation** — arbre + liste ou miniatures, tri, fil d'Ariane, dossiers épinglés, fichiers
cachés masqués par défaut (y compris l'attribut caché Windows et les dossiers système Synology).

**Fichiers** — créer, renommer, déplacer, supprimer (définitif, avec le poids annoncé),
taille d'un dossier. Ouvrir un fichier distant l'ouvre dans l'application associée ; s'il est
modifié, Copiteur propose de le **renvoyer sur le serveur**, en détectant les conflits.

**Journal** — trace horodatée filtrable, et un « rapport » copiable qui contient versions,
système et réglages, jamais de mot de passe.

## Développer

```bash
cd tauri
npm install
npm run prepare-bins      # télécharge rclone et vérifie son empreinte SHA-256
npm run tauri dev         # lance l'app
npm run tauri build       # installeurs
```

Vérifications :

```bash
npx tsc --noEmit                    # types
cd src-tauri && cargo test          # tests (sécurité API, journal, édition, chemins)
```

## Pourquoi rclone

Une connexion SFTP plafonne à ~11 Mo/s sur un lien à latence : c'est la limite d'**une**
connexion, pas du réseau. FileZilla ne parallélise qu'**entre** fichiers — dès qu'il ne reste
qu'un gros fichier, on retombe à 11 Mo/s. rclone sait découper **un seul fichier** en plusieurs
flux sur le même serveur, sans rien installer côté NAS.

Mesuré sur un NAS distant via VPN (2026-07-10, un seul gros fichier) :

| Méthode | Débit | Stabilité |
|---|---|---|
| 1 connexion (SFTP nu / SMB) | ~11 Mo/s | stable — le plafond à battre |
| `rclone mount` + chunks | 70-90 Mo/s | erratique, inutilisable |
| `rclone copy --multi-thread-streams 16 --multi-thread-chunk-size 128M` | **107 Mo/s** | **stable** |

Confirmé en usage réel : **142 Mo/s** agrégés sur une copie de 450 Go (2026-07-17).
Ces valeurs sont les défauts de l'app, ajustables dans les réglages.

## Décisions techniques

**Pilotage par l'API de rclone** (`rclone rcd`), pas par du texte parsé. L'app parle en HTTP
local au daemon : listages, copies asynchrones, stats par transfert, annulation propre.

**Réglages posés globalement** sur le daemon (`options/set`, bloc `main`), jamais par job.
Un `_config` par copie faisait diverger les instances de connexion entre le transfert et le
renommage qui suit.

**Écriture directe** (`--inplace`), comme FileZilla. Par défaut rclone écrit un `.partial`
puis le renomme ; ce renommage déclenche par intermittence
[rclone#8653](https://github.com/rclone/rclone/issues/8653) (`can't move object - incompatible
remotes`), constaté massivement sur une copie de 450 Go, tous calibres — donc pas lié au
multi-thread, c'est le renommage lui-même. `--inplace` supprime l'étape, donc le bug.
*Contrepartie assumée* : une copie interrompue laisse un fichier tronqué à son nom final ;
la reprise le réécrit. À reconsidérer si rclone corrige la régression.

**Vérification d'empreinte abandonnée à la volée** quand le serveur ne sait pas en produire.
rclone calcule l'empreinte distante en lançant `md5sum` **par SSH** ; si le compte ne peut pas
exécuter de commande, rclone prend la réponse inexploitable pour une empreinte et la compare —
« corrupted on transfer: md5 hashes differ » avec une valeur vide d'un côté, et **tous** les
transferts échouent. Copiteur reconnaît la signature (un md5 fait 32 hexadécimaux), bascule la
connexion en `disable_hashcheck` et relance. La taille reste vérifiée. Par serveur, remis à
zéro à chaque connexion : ceux dont les empreintes marchent les gardent.

**Délais courts** (`Timeout` 1 min au lieu de 5) pour échouer vite sur un lien mort et laisser
la reprise travailler, plutôt que de rester pendu.

## Pièges rencontrés

- **Chemins Synology** : DSM affiche `/volume1/PARTAGE`, mais en SFTP l'utilisateur est posé à
  la racine des partages — le chemin rclone correct est `remote:/PARTAGE/…`, sans `/volume1`.
- **`operations/list` renvoie un `Path` relatif au `fs`**, pas au couple `{fs, remote}`. Le
  re-joindre à la racine doublait le chemin et cassait toute copie de dossier depuis le serveur.
- **`BwLimit` vide fait échouer tout le bloc `options/set`** (« empty string »), ce qui annulait
  aussi les réglages multi-thread. On envoie `0` pour « illimité ».
- **Windows interdit `? < > | " * :`** dans un nom. rclone les remplace par leurs équivalents
  Unicode pleine chasse (`？` `＜`…), qui s'affichent à la largeur d'un idéogramme. Un aller-retour
  NAS → Windows → NAS n'est donc pas neutre.
- **Cmd+Q sur macOS ne passe pas par la fermeture de fenêtre** : le menu par défaut est câblé sur
  `NSApp terminate:`, qui court-circuite la boucle d'événements. Il faut un menu custom pour
  l'intercepter.
- **`scrollbar-gutter` ne réserve rien sous macOS** (barres en surimpression) : là où il faut
  vraiment dégager de la place, seul un retrait explicite fonctionne.
- Hérités du template : commande Tauri synchrone = gel de l'UI (tout en async) ; `no_window()`
  obligatoire sur les `Command` Windows ; Mica en `expect` = crash sur Windows 10.

## Sécurité

**L'API de rclone est fermée par un secret** tiré au hasard à chaque lancement (32 octets).
Cette API peut tout faire — lire, copier, **supprimer récursivement**, lire la config. Sans
secret, n'importe quel programme de la session pouvait la piloter tant que Copiteur tournait,
et une simple page web pouvait lui envoyer des requêtes « simples » qui partent sans
pré-vérification CORS. Le secret transite par l'**environnement** du process, jamais par sa
ligne de commande, que `ps` et le Gestionnaire des tâches exposent. Verrouillé par des tests.

**Le binaire rclone est épinglé et vérifié** : version figée et empreinte SHA-256 dans le dépôt.
`scripts/prepare-bins.mjs` refuse une archive qui ne correspond pas — utile même si le serveur
de téléchargement est un jour compromis, puisque ce binaire finit dans l'installeur signé.

**Seules les commandes rclone dont l'app se sert passent.** Le pont entre l'interface et
rclone n'accepte que 16 méthodes de l'API, et refuse tout paramètre ou chemin qui ferait
lancer un programme par rclone (option SFTP `ssh`, remotes créés à la volée `:sftp,…:`,
`core/command`…). Même une faille d'affichage future ne donnerait pas d'exécution de code.
Couvert par des tests.

**La config rclone reste en mémoire** (`--config ""`) : le mot de passe du serveur courant
n'est jamais écrit dans un `rclone.conf`.

**Politique de sécurité du contenu (CSP) stricte** : l'interface ne charge que ses propres
fichiers, aucun script ni ressource extérieure.

## Licence

[MIT](LICENSE). rclone est distribué sous licence MIT, cf.
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
