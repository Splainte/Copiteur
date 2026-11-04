//go:build cgo && darwin

package usbmtp

import (
	"os/exec"
)

// releaseImageCapture : sur macOS recent, le service « Transfert d'images »
// (ptpcamerad, aide de mscamerad-xpc) s'empare en EXCLUSIVITE de l'interface
// MTP de tout telephone branche — libusb ne peut alors plus la reclamer
// (LIBUSB_ERROR_ACCESS). Comme les correctifs d'OpenMTP (PR #483), on arrete
// ces deux processus (ils tournent dans la session de l'utilisateur, aucun
// droit administrateur) et on reclame l'interface IMMEDIATEMENT : launchd les
// relance en quelques millisecondes, mais une interface deja tenue ne leur
// est plus donnee. SIGKILL : ils ignorent SIGTERM. Nom EXACT (-x), jamais un
// motif. Verifie sur un Pixel 9 Pro XL / macOS 27.2.
func releaseImageCapture() bool {
	ok := false
	for _, name := range []string{"ptpcamerad", "mscamerad-xpc"} {
		// pkill rend 0 si au moins un processus a ete trouve.
		if exec.Command("/usr/bin/pkill", "-9", "-x", name).Run() == nil {
			ok = true
		}
	}
	return ok
}
