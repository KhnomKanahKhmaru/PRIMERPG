// char-bio.js
// Handles the bio/identity section at the top of the character sheet:
//   - Portrait upload
//   - Name, paradigm, archetype header
//   - Tagline/quip
//   - Bio prose ("___ is a __-year-old ___ from ___")
//   - Edit form for bio fields (including playgroup attachment)
//   - "Etc." free-form notes field
//
// The bio section's renderBio() also triggers the xp bar's renderPowerBar(),
// because the power bar lives in the header alongside the bio. The xpBar
// instance is passed in via ctx.
//
// Factory pattern. createBioSection(ctx) returns bound handlers.

import {
  auth,
  saveCharacter,
  loadPlaygroup,
  uploadCharacterPortrait
} from './char-firestore.js';

export function createBioSection(ctx) {
  // ctx shape:
  //   getCharData()         -> live charData
  //   getCanEdit()          -> boolean
  //   getCharId()           -> string
  //   getUserPlaygroups()   -> array of { id, name } for the playgroup picker
  //   getXpBar()            -> the xpBar instance (for renderPowerBar)

  // ─── PROSE BUILDER ───

  // Assembles the "<name> is a <sex> <age>-year-old <ethnicity> <paradigm>
  // <archetype> living in <residence>, from the World of <playgroup>."
  // line and the "typically appears as" line below it. Fields that are
  // empty just get skipped so the prose stays grammatical.
  function buildProse(d, pgName) {
    const name = d.name ? `<b>${d.name}</b>` : '___';
    let line1 = `${name} is a`;
    if (d.sex)       line1 += ` <b>${d.sex}</b>`;
    if (d.age)       line1 += ` <b>${d.age}</b> year old`;
    if (d.ethnicity) line1 += ` <b>${d.ethnicity}</b>`;
    if (d.paradigm)  line1 += ` <b>${d.paradigm}</b>`;
    if (d.archetype) line1 += ` <b>${d.archetype}</b>`;
    if (d.residence) line1 += ` living in <b>${d.residence}</b>`;
    if (pgName)      line1 += `, from the World of <b>${pgName}</b>.`;
    else             line1 += '. Currently, they are not an active Character in play.';

    const name2 = d.name ? `<b>${d.name}</b>` : '___';
    let line2 = `${name2} <b>typically appears as</b>`;
    if (d.appearance) line2 += ` <i>${d.appearance}</i>`;

    return line1 + '<br><br>' + line2;
  }

  // Return the name of the character's attached playgroup, or null if they
  // have no playgroup or the user is logged out.
  async function getActivePgName() {
    const charData = ctx.getCharData();
    if (!charData.playgroupId || !auth.currentUser) return null;
    const pg = await loadPlaygroup(charData.playgroupId);
    return pg ? pg.name : null;
  }

  // ─── MAIN RENDER ───

  async function renderBio() {
    const charData = ctx.getCharData();
    const pgName = await getActivePgName();

    document.getElementById('bio-prose').innerHTML = buildProse(charData, pgName);
    document.getElementById('char-name').textContent = charData.name || 'Unnamed';
    document.getElementById('char-archetype').textContent =
      [charData.paradigm, charData.archetype].filter(Boolean).join(' · ') || '';

    // The XP/AP pill sits in the page header strip (top-right of the
    // page, visible across all tabs). Refresh it whenever the bio
    // re-renders so any stat-affecting bio edits propagate to the
    // economy display.
    ctx.getXpBar().renderPowerBar();

    // Tagline / quip styling differs depending on whether there's text.
    const quipEl = document.getElementById('char-quip');
    if (charData.quip) {
      quipEl.textContent = `"${charData.quip}"`;
      quipEl.classList.add('has-quip');
    } else {
      quipEl.textContent = 'Tagline / Quip';
      quipEl.classList.remove('has-quip');
    }

    document.getElementById('etc-content').textContent = charData.etc || '—';

    // Portrait visibility.
    if (charData.pictureUrl) {
      document.getElementById('pic-placeholder').style.display = 'none';
      const img = document.getElementById('char-img');
      img.src = charData.pictureUrl;
      img.style.display = 'block';
    }
  }

  // ─── BIO EDIT FORM ───

  // Field list shared by editBio, updatePreview, and saveBio.
  const BIO_FIELDS = ['name','sex','age','ethnicity','paradigm','archetype','residence','appearance'];

  function editBio() {
    document.getElementById('bio-view').style.display = 'none';
    document.getElementById('bio-edit-btn').style.display = 'none';
    document.getElementById('bio-edit').style.display = 'block';

    const charData = ctx.getCharData();
    BIO_FIELDS.forEach(f => {
      document.getElementById('e-' + f).value = charData[f] || '';
    });

    // Playgroup dropdown: always offers "None", plus whichever playgroups
    // the current user is a member of.
    const sel = document.getElementById('e-playgroup');
    sel.innerHTML = '<option value="">None — not in active play</option>';
    ctx.getUserPlaygroups().forEach(pg => {
      const opt = document.createElement('option');
      opt.value = pg.id;
      opt.textContent = pg.name;
      if (charData.playgroupId === pg.id) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function cancelBio() {
    document.getElementById('bio-view').style.display = 'block';
    document.getElementById('bio-edit-btn').style.display = 'inline';
    document.getElementById('bio-edit').style.display = 'none';
  }

  // Live-update the prose as the user types in the edit form — shows what
  // the saved result will look like without committing to Firestore.
  function updatePreview() {
    const d = {};
    BIO_FIELDS.forEach(f => {
      d[f] = document.getElementById('e-' + f).value.trim();
    });
    const selectedId = document.getElementById('e-playgroup').value;
    const pg = ctx.getUserPlaygroups().find(p => p.id === selectedId);
    document.getElementById('bio-prose').innerHTML = buildProse(d, pg ? pg.name : null);
  }

  async function saveBio() {
    if (!ctx.getCanEdit()) return;
    const msg = document.getElementById('bio-msg');
    const updated = {};
    BIO_FIELDS.forEach(f => {
      updated[f] = document.getElementById('e-' + f).value.trim();
    });
    updated.playgroupId = document.getElementById('e-playgroup').value || null;

    try {
      await saveCharacter(ctx.getCharId(), updated);
      Object.assign(ctx.getCharData(), updated);
      await renderBio();
      msg.textContent = 'Saved!';
      setTimeout(() => { msg.textContent = ''; cancelBio(); }, 1000);
    } catch (e) {
      msg.textContent = 'Error saving.';
      msg.style.color = '#ff6666';
    }
  }

  // ─── TAGLINE / QUIP ───

  function editQuip() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const val = prompt('Enter tagline / quip:', charData.quip || '');
    if (val === null) return;
    saveCharacter(ctx.getCharId(), { quip: val }).then(() => {
      charData.quip = val;
      renderBio();
    });
  }

  // ─── "ETC." FREE-FORM FIELD ───

  function editEtc() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    document.getElementById('etc-content').style.display = 'none';
    document.getElementById('etc-edit').value = charData.etc || '';
    document.getElementById('etc-edit').style.display = 'block';
    document.getElementById('etc-btn-row').style.display = 'block';
  }

  function cancelEtc() {
    document.getElementById('etc-content').style.display = 'block';
    document.getElementById('etc-edit').style.display = 'none';
    document.getElementById('etc-btn-row').style.display = 'none';
  }

  async function saveEtc() {
    if (!ctx.getCanEdit()) return;
    const val = document.getElementById('etc-edit').value.trim();
    try {
      await saveCharacter(ctx.getCharId(), { etc: val });
      ctx.getCharData().etc = val;
      document.getElementById('etc-content').textContent = val || '—';
      cancelEtc();
    } catch (e) {
      alert('Error saving.');
    }
  }

  // ─── PORTRAIT UPLOAD ───

  function triggerPicUpload() {
    if (ctx.getCanEdit()) document.getElementById('pic-input').click();
  }

  async function handlePicChange(e) {
    if (!ctx.getCanEdit()) return;
    const file = e.target.files[0];
    if (!file) return;
    const slot = document.getElementById('picture-slot');
    const overlay = document.createElement('div');
    overlay.className = 'pic-uploading';
    overlay.textContent = 'Uploading...';
    slot.appendChild(overlay);
    try {
      const url = await uploadCharacterPortrait(ctx.getCharId(), file);
      await saveCharacter(ctx.getCharId(), { pictureUrl: url });
      ctx.getCharData().pictureUrl = url;
      document.getElementById('pic-placeholder').style.display = 'none';
      const img = document.getElementById('char-img');
      img.src = url;
      img.style.display = 'block';
    } catch (err) {
      alert('Upload failed.');
    } finally {
      slot.removeChild(overlay);
    }
  }

  return {
    // Rendering
    renderBio,

    // Edit form
    editBio, cancelBio, updatePreview, saveBio,

    // Tagline
    editQuip,

    // Etc
    editEtc, cancelEtc, saveEtc,

    // Portrait
    triggerPicUpload, handlePicChange,
  };
}
