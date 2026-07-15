// ============================================================
// FIREBASE CONFIG — fill this in with YOUR Firebase project's values.
// Get these from: Firebase Console → Project Settings → General → Your apps → Web app
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";

export const firebaseConfig = {
  apiKey: "AIzaSyCVMKjeQ5Lz_Q7FHNu8nNwN0uvCG4aK2j8",
  authDomain: "visisthub.firebaseapp.com",
  projectId: "visisthub",
  storageBucket: "visisthub.firebasestorage.app",
  messagingSenderId: "705861895957",
  appId: "1:705861895957:web:849932d04488f3760a0b1c"
};

export const app = initializeApp(firebaseConfig);

// ============================================================
// USERNAME → EMAIL MAP
// Firebase Auth needs an email format even though people will type a
// plain username at login. This map converts "mourya" -> "mourya@visistcrm.app"
// behind the scenes. Add/remove people here — this list is also mirrored
// in the `users` Firestore collection (see SETUP.md) which controls
// permissions, so keep both in sync.
// ============================================================
export const USERNAME_DOMAIN = "visistcrm.app";

export function usernameToEmail(username) {
  return `${username.trim().toLowerCase()}@${USERNAME_DOMAIN}`;
}