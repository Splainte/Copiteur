# copiteur-mtp — composants tiers

Ce fichier recense ce qui est compilé dans le binaire `copiteur-mtp`
(sidecar macOS). La section ci-dessous, entre les deux lignes `---`, est prête
à être collée dans `THIRD-PARTY-NOTICES.md` à la racine du dépôt.

Vérification de la liste : `go version -m <binaire>` ne montre que trois
modules tiers (`github.com/ganeshrvel/go-mtpfs`, `github.com/ganeshrvel/usb`,
`golang.org/x/text`) ;
`go.sum` mentionne aussi `go-fuse` et `golang.org/x/sys` mais ils ne sont pas
compilés (seul le paquet `mtp` de go-mtpfs est importé). libusb est liée
statiquement par `tauri/scripts/build-mtp.mjs`.

---

## copiteur-mtp (téléphones Android en MTP, macOS)

Copiteur embarque sur macOS un petit programme, `copiteur-mtp`, qui expose les
téléphones Android branchés en USB (protocole MTP) comme un serveur WebDAV
local pour rclone. Source : `tauri/mtp/` dans ce dépôt. Il contient les
composants suivants.

### go-mtpfs (paquet `mtp`) — licence BSD

https://github.com/ganeshrvel/go-mtpfs (fork maintenu par l'auteur d'OpenMTP
de https://github.com/hanwen/go-mtpfs). Le fichier
`tauri/mtp/internal/usbmtp/transport.go` est dérivé de ses fichiers `mtp.go`,
`ops.go`, `android.go` et `select.go` (modifications décrites en tête du
fichier).

### usb (liaison Go de libusb) — licence BSD

https://github.com/ganeshrvel/usb (fork de https://github.com/hanwen/usb).

Les deux composants ci-dessus sont distribués sous la licence suivante :

```
New BSD License

Copyright (c) 2012 Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Ivan Krasin nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### libusb 1.0.29 — licence LGPL-2.1 ou ultérieure

https://libusb.info — liée **statiquement** dans `copiteur-mtp`.

```
Copyright © 2001 Johannes Erdfelt <johannes@erdfelt.com>
Copyright © 2007-2009 Daniel Drake <dsd@gentoo.org>
Copyright © 2010-2012 Peter Stuge <peter@stuge.se>
Copyright © 2008-2016 Nathan Hjelm <hjelmn@users.sourceforge.net>
Copyright © 2009-2013 Pete Batard <pete@akeo.ie>
Copyright © 2009-2013 Ludovic Rousseau <ludovic.rousseau@gmail.com>
Copyright © 2010-2012 Michael Plante <michael.plante@gmail.com>
Copyright © 2011-2013 Hans de Goede <hdegoede@redhat.com>
Copyright © 2012-2013 Martin Pieuchot <mpi@openbsd.org>
Copyright © 2012-2013 Toby Gray <toby.gray@realvnc.com>
Copyright © 2013-2018 Chris Dickens <christopher.a.dickens@gmail.com>
Copyright © 2019-2023 Google LLC
et les autres contributeurs listés dans le fichier AUTHORS de libusb.

This library is free software; you can redistribute it and/or modify it
under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation; either version 2.1 of the License, or (at
your option) any later version.

This library is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser
General Public License for more details.
```

Texte complet de la licence : https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
(également dans le fichier `COPYING` de l'archive source de libusb).

**Code source de libusb et nouvelle édition de liens (LGPL-2.1, section 6).**
La version utilisée est l'archive officielle, non modifiée :
https://github.com/libusb/libusb/releases/download/v1.0.29/libusb-1.0.29.tar.bz2
(SHA-256 `5977fc950f8d1395ccea9bd48c06b3f808fd3c2c961b44b0c2e6e29fc3a70a85`).
Copiteur étant open source, tout le code nécessaire pour reconstruire
`copiteur-mtp` avec une autre version (éventuellement modifiée) de libusb est
public : `tauri/mtp/` (programme) et `tauri/scripts/build-mtp.mjs` (script de
construction : compile libusb en bibliothèque statique puis lie le
programme). Pour utiliser votre propre libusb, remplacez l'archive (variables
`LIBUSB_URL` / `LIBUSB_SHA256`) ou fournissez votre propre `libusb-1.0.a`, puis
relancez `node scripts/build-mtp.mjs --force` et remplacez le binaire
`copiteur-mtp` dans `Copiteur.app/Contents/MacOS/`.

### Go (bibliothèque standard et environnement d'exécution) et golang.org/x/text — licence BSD

https://go.dev — compilés dans tout programme Go. `golang.org/x/text`
(https://pkg.go.dev/golang.org/x/text, paquet `unicode/norm`, normalisation
NFC des noms de fichiers) est publié par les mêmes auteurs sous la même
licence.

```
Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---
