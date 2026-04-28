#!/usr/bin/env node
/**
 * One-time Firestore migration: rename SAN → MEN on character docs.
 *
 * Renames three fields on every document in `characters/`:
 *   sanDamage      → menDamage
 *   sanDamages     → menDamages
 *   sanModifiers   → menModifiers
 *
 * The data values move unchanged. The legacy `san*` fields are deleted
 * after the copy. Idempotent — running twice is safe (the second run
 * sees no `san*` fields and is a no-op).
 *
 * Usage:
 *   1. Make sure firebase-admin is installed:  npm install firebase-admin
 *   2. Place a service-account key JSON at ./service-account.json
 *      (download from Firebase Console → Project Settings → Service
 *       Accounts → Generate new private key)
 *   3. node migrate-san-to-men.js [--dry-run]
 *
 * --dry-run: print what would change without writing anything. Strongly
 *            recommended for a first pass.
 *
 * The script processes characters in batches and prints a per-doc
 * summary. After it finishes, every character should have menDamage /
 * menDamages / menModifiers and no more sanDamage / sanDamages /
 * sanModifiers.
 */

const admin = require('firebase-admin');
const path = require('path');

const SA_PATH = process.env.SA_PATH || './service-account.json';
const DRY_RUN = process.argv.includes('--dry-run');

const sa = require(path.resolve(SA_PATH));
admin.initializeApp({ credential: admin.credential.cert(sa) });

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

(async () => {
  const charsRef = db.collection('characters');
  const snap = await charsRef.get();
  console.log(`Found ${snap.size} character documents${DRY_RUN ? ' (DRY RUN)' : ''}`);

  let migrated = 0, skipped = 0, errors = 0;
  // We process docs sequentially. Could be batched 500 at a time for
  // speed but characters are typically a small collection (hundreds
  // of docs at most) so the simpler one-at-a-time loop is fine.
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const update = {};
    let touched = false;

    // sanDamage (number) → menDamage. If both exist somehow, the new
    // field wins (it's the source of truth post-migration). Then drop
    // the legacy field.
    if (typeof data.sanDamage === 'number') {
      if (typeof data.menDamage !== 'number') {
        update.menDamage = data.sanDamage;
      }
      update.sanDamage = FieldValue.delete();
      touched = true;
    }

    // sanDamages (array) → menDamages
    if (Array.isArray(data.sanDamages)) {
      if (!Array.isArray(data.menDamages)) {
        update.menDamages = data.sanDamages;
      }
      update.sanDamages = FieldValue.delete();
      touched = true;
    }

    // sanModifiers (array) → menModifiers
    if (Array.isArray(data.sanModifiers)) {
      if (!Array.isArray(data.menModifiers)) {
        update.menModifiers = data.sanModifiers;
      }
      update.sanModifiers = FieldValue.delete();
      touched = true;
    }

    if (!touched) {
      skipped++;
      continue;
    }

    const summary = Object.keys(update)
      .filter(k => !k.startsWith('san'))
      .map(k => k)
      .join(', ') || '(legacy fields only)';

    if (DRY_RUN) {
      console.log(`  [DRY] ${doc.id}: would set { ${summary} } and delete legacy san* fields`);
      migrated++;
    } else {
      try {
        await doc.ref.update(update);
        console.log(`  ✓    ${doc.id}: migrated (${summary})`);
        migrated++;
      } catch (e) {
        console.error(`  ✗    ${doc.id}: ${e.message}`);
        errors++;
      }
    }
  }

  console.log('');
  console.log(`Done. Migrated: ${migrated}, skipped: ${skipped}, errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
