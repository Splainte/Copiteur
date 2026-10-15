@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Build de Copiteur pour Windows
echo ============================================
echo.

rem --- Verification des prerequis -----------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js est introuvable.
  echo     Installe-le depuis https://nodejs.org ^(version LTS^) puis relance.
  echo.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [X] Rust / cargo est introuvable.
  echo     Installe Rust depuis https://rustup.rs puis rouvre une fenetre.
  echo     Il faut aussi "Microsoft C++ Build Tools" ^(Visual Studio Installer^).
  echo.
  pause
  exit /b 1
)

rem --- 1. Dependances npm --------------------------------------------------
echo [1/4] Installation des dependances npm...
call npm install
if errorlevel 1 (
  echo [X] Echec de "npm install".
  pause
  exit /b 1
)
echo.

rem --- 2. rclone (sidecar) -------------------------------------------------
echo [2/4] Telechargement de rclone ^(moteur de transfert^)...
call node scripts\prepare-bins.mjs
if errorlevel 1 (
  echo [X] Echec du telechargement de rclone.
  pause
  exit /b 1
)
echo.

rem --- 3. Build Tauri ------------------------------------------------------
echo [3/4] Compilation de l'application...
echo       ^(le premier build peut prendre plusieurs minutes^)
call npx tauri build
if errorlevel 1 (
  echo [X] Echec du build Tauri.
  pause
  exit /b 1
)
echo.

rem --- 4. Resultat --------------------------------------------------------
echo [4/4] Termine !
set "OUT=src-tauri\target\release\bundle\nsis"
echo.
echo Installeur genere dans :
echo   %CD%\%OUT%
echo.
if exist "%OUT%" (
  explorer "%OUT%"
) else (
  echo ^(Dossier de sortie introuvable : verifie les messages ci-dessus.^)
)
echo.
pause
