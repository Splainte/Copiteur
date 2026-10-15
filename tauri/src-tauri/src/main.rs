// Empeche une console supplementaire sur Windows en release, NE PAS RETIRER !
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    copiteur_lib::run()
}
