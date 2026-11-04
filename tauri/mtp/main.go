// copiteur-mtp : expose les telephones Android branches en USB (protocole
// MTP) comme un serveur WebDAV local, pour que rclone les traite comme
// n'importe quel remote. Sidecar de Copiteur (macOS uniquement en
// production).
//
// Contrat de processus (voir NOTICES.md / README de l'integration Rust) :
//   - jeton dans COPITEUR_MTP_TOKEN (>= 32 caracteres), jamais en argument ;
//   - ecoute sur 127.0.0.1 uniquement (--port, 0 = choisi par l'OS) ;
//   - une seule ligne sur stdout : {"port":N} ; les journaux vont sur stderr ;
//   - s'arrete a la fin de stdin (parent mort) et sur SIGTERM/SIGINT.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"copiteur-mtp/internal/fake"
	"copiteur-mtp/internal/server"
	"copiteur-mtp/internal/usbmtp"
)

func main() {
	log.SetFlags(log.Ltime)
	log.SetPrefix("copiteur-mtp: ")
	log.SetOutput(os.Stderr)

	port := flag.Int("port", 0, "TCP port on 127.0.0.1 (0 = chosen by the OS)")
	fakeDir := flag.String("fake", "", "simulate a phone backed by this directory instead of USB")
	fakeName := flag.String("fake-name", "Téléphone de test", "name of the simulated phone")
	fakeDelay := flag.Int("fake-delay-ms", 0, "simulated USB cost: N ms per transaction and N ms per MiB (33 ~ 30 MB/s)")
	flag.Parse()

	token := os.Getenv("COPITEUR_MTP_TOKEN")
	if len(token) < 32 {
		log.Print("COPITEUR_MTP_TOKEN missing or shorter than 32 characters, refusing to start")
		os.Exit(2)
	}

	var m server.Manager
	if *fakeDir != "" {
		fm, err := fake.NewManager(*fakeDir, fake.Options{
			Name:  *fakeName,
			Delay: time.Duration(*fakeDelay) * time.Millisecond,
		})
		if err != nil {
			log.Printf("fake backend: %v", err)
			os.Exit(1)
		}
		m = fm
		log.Printf("fake phone backed by %s", *fakeDir)
	} else {
		um, err := usbmtp.NewManager()
		if err != nil {
			log.Printf("USB backend: %v", err)
			os.Exit(1)
		}
		m = um
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Printf("listen: %v", err)
		m.Close()
		os.Exit(1)
	}
	srv := &http.Server{
		Handler:           server.New(token, m),
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          log.New(io.Discard, "", 0), // ErrAbortHandler et clients partis : bruit
	}
	line, _ := json.Marshal(map[string]int{"port": ln.Addr().(*net.TCPAddr).Port})
	if _, err := fmt.Fprintf(os.Stdout, "%s\n", line); err != nil {
		os.Exit(1)
	}
	os.Stdout.Close() // plus rien sur stdout

	stop := make(chan string, 2)
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop <- "stdin closed"
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() { stop <- (<-sig).String() }()
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			stop <- "server: " + err.Error()
		}
	}()

	why := <-stop
	log.Printf("shutting down (%s)", why)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = srv.Shutdown(ctx)
	cancel()
	_ = srv.Close()
	m.Close()
	log.Print("bye")
}
