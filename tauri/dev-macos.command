#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  Copiteur — dev macOS"
echo "============================================"
echo

# --- Verification des prerequis --------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js est introuvable."
  echo "    Installe-le (brew install node, ou https://nodejs.org) puis relance."
  read -p "Appuie sur Entree pour fermer..."
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "[X] Rust / cargo est introuvable."
  echo "    Installe-le depuis https://rustup.rs puis rouvre un Terminal."
  read -p "Appuie sur Entree pour fermer..."
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "[X] Les Command Line Tools de Xcode sont introuvables."
  echo "    Lance : xcode-select --install"
  read -p "Appuie sur Entree pour fermer..."
  exit 1
fi

# --- 1. Dependances npm -----------------------------------------------------
echo "[1/3] Installation des dependances npm..."
npm install
echo

# --- 2. rclone (sidecar) -----------------------------------------------------
echo "[2/3] Telechargement de rclone (moteur de transfert)..."
node scripts/prepare-bins.mjs
echo

# --- 3. Lancement en dev -----------------------------------------------------
echo "[3/3] Lancement de Copiteur en mode dev..."
echo "      (le premier build Rust peut prendre plusieurs minutes)"
echo
npm run tauri dev
