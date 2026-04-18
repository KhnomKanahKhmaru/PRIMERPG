// char-firestore.js
// All Firebase I/O (reads, writes, storage, auth) for the character sheet.
// Other modules import named helpers from here instead of touching Firestore
// directly — this keeps the data layer in one place and makes it trivial
// to swap backends later if we ever want to.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
import {
  getFirestore,
  doc, getDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCf94yLvAtJ9pLgJ3FsV7ir4Qh9XXm3nHg",
  authDomain: "prime-rpg.firebaseapp.com",
  projectId: "prime-rpg",
  storageBucket: "prime-rpg.firebasestorage.app",
  messagingSenderId: "177905987748",
  appId: "1:177905987748:web:8856ab4fdb8f81f42eb631"
};

const app = initializeApp(firebaseConfig);

// Handles that other modules need direct access to.
// Prefer using the named helpers below when possible.
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Re-export the auth callbacks we use.
export { onAuthStateChanged, signOut };

// ── CHARACTERS ──

// Load a character doc by ID. Returns the data object, or null if the doc
// does not exist.
export async function loadCharacter(charId) {
  const snap = await getDoc(doc(db, 'characters', charId));
  return snap.exists() ? snap.data() : null;
}

// Update one or more fields on a character. Field names can use dot-paths
// (e.g. `stats.str`) — that's a plain Firestore feature.
export async function saveCharacter(charId, fields) {
  await updateDoc(doc(db, 'characters', charId), fields);
}

// Permanently delete a character.
export async function deleteCharacter(charId) {
  await deleteDoc(doc(db, 'characters', charId));
}

// ── USERS ──

export async function loadUser(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

// ── PLAYGROUPS ──

export async function loadPlaygroup(pgId) {
  const snap = await getDoc(doc(db, 'playgroups', pgId));
  return snap.exists() ? snap.data() : null;
}

// Load all playgroups this user is a member of, returned as
// [{id, name}, ...]. Membership role is not included here — if you need
// it, load memberships separately.
export async function loadUserPlaygroups(uid) {
  const memQ = query(collection(db, 'memberships'), where('uid', '==', uid));
  const memSnap = await getDocs(memQ);
  const out = [];
  for (const m of memSnap.docs) {
    const pgId = m.data().playgroupId;
    const pg = await loadPlaygroup(pgId);
    if (pg) out.push({ id: pgId, name: pg.name });
  }
  return out;
}

// ── RULESETS ──

// Load the Basic Set ruleset. Returns the doc data with `id` attached,
// or null if no Basic Set is defined.
export async function loadBasicSet() {
  const q = query(collection(db, 'rulesets'), where('isBasicSet', '==', true));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// Load all rulesets attached to a given playgroup.
export async function loadPlaygroupRulesets(pgId) {
  const q = query(collection(db, 'rulesets'), where('playgroupId', '==', pgId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── STORAGE ──

// Upload a character portrait and return its public download URL.
export async function uploadCharacterPortrait(charId, file) {
  const storageRef = ref(storage, `characters/${charId}/portrait`);
  await uploadBytes(storageRef, file);
  return await getDownloadURL(storageRef);
}

// ── RULESET RESOLUTION ──

// Pick the ruleset that governs a character. Policy: use the first
// ruleset attached to the character's playgroup; fall back to the Basic
// Set; fall back to the hardcoded defaults. Returns a fully-normalized
// ruleset object (every schema field populated), never null.
//
// Relies on window.normalizeRuleset being defined — that comes from
// ruleset-defaults.js, loaded as a classic <script> tag in the HTML
// head (not an ES import, because it's shared across non-module pages).
export async function resolveActiveRuleset(charData) {
  let raw = null;

  // 1. Try the playgroup's attached ruleset(s). If multiple are attached
  //    we use the first one — a "primary ruleset" flag can come later.
  if (charData && charData.playgroupId) {
    const rulesets = await loadPlaygroupRulesets(charData.playgroupId);
    if (rulesets.length > 0) raw = rulesets[0];
  }

  // 2. Fall back to the Basic Set.
  if (!raw) raw = await loadBasicSet();

  // 3. Normalize (fills in every missing field from RULESET_DEFAULTS).
  //    If normalizeRuleset isn't loaded for some reason, pass through.
  const normalize = (typeof window !== 'undefined' && window.normalizeRuleset)
    ? window.normalizeRuleset
    : (rs => rs || {});
  return normalize(raw || {});
}
