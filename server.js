// ============================================================
//  Journal de prospection — service autonome, zéro dépendance
//  Stockage : un fichier JSON sur disque (volume Docker)
//  Auth     : en-tête  Authorization: Bearer <LEDGER_TOKEN>
//             (ou  x-ledger-token: <token>  ou  ?token=<token>)
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ledger.json');
const TOKEN = String(process.env.LEDGER_TOKEN || '');
const MAX_BODY = 4 * 1024 * 1024; // 4 Mo
const MAX_EVENTS = 5000;
const MAX_REPORTS = 500;

const EN_COURS = ['a_contacter', 'en_sequence'];

// ------------------------------------------------------------ stockage
let db = { version: 1, seq: 0, prospects: {}, suppression: [], events: [], reports: [] };

function charger() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const brut = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = Object.assign(db, brut);
      db.prospects = db.prospects || {};
      db.suppression = db.suppression || [];
      db.events = db.events || [];
      db.reports = db.reports || [];
    }
  } catch (e) {
    console.error('[ledger] lecture impossible, on repart sur une base vide :', e.message);
  }
}

function sauver() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, DATA_FILE); // écriture atomique
  } catch (e) {
    console.error('[ledger] écriture impossible :', e.message);
  }
}

const maintenant = () => new Date().toISOString();

// ------------------------------------------------------------ utilitaires
function envoyer(res, code, corps, type) {
  const txt = typeof corps === 'string' ? corps : JSON.stringify(corps);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(txt),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ledger-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(txt);
}

function lireBody(req) {
  return new Promise((resolve, reject) => {
    let taille = 0;
    const morceaux = [];
    req.on('data', (c) => {
      taille += c.length;
      if (taille > MAX_BODY) { reject(new Error('corps trop volumineux')); req.destroy(); return; }
      morceaux.push(c);
    });
    req.on('end', () => {
      const brut = Buffer.concat(morceaux).toString('utf8').trim();
      if (!brut) return resolve({});
      try { resolve(JSON.parse(brut)); }
      catch (e) { reject(new Error('JSON invalide : ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function autorise(req, url) {
  if (!TOKEN) return true; // pas de jeton configuré = accès libre (à éviter en public)
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const fourni = (m && m[1]) || req.headers['x-ledger-token'] || url.searchParams.get('token') || '';
  return String(fourni) === TOKEN;
}

const texte = (v) => String(v === undefined || v === null ? '' : v).trim();
const slug = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function idProspect(p) {
  const id = texte(p.prospect_id) || texte(p.place_id) || texte(p.id);
  if (id) return id;
  return slug(texte(p.nom) + '-' + texte(p.ville)) || 'PROSPECT-' + (db.seq + 1);
}

// ------------------------------------------------------------ prospects
const CHAMPS_FACTUELS = ['nom', 'categorie', 'ville', 'wilaya_code', 'adresse', 'telephone',
  'email', 'email_alt', 'site', 'note', 'nb_avis', 'place_id', 'source', 'score',
  'priorite', 'angle', 'raisons', 'canal_principal', 'motif_exclusion', 'categorie_metier'];

function upsert(brut) {
  const base = brut && typeof brut === 'object' ? brut : {};
  const id = idProspect(base);
  const existant = db.prospects[id];
  const maintenantIso = maintenant();

  if (!existant) {
    db.seq += 1;
    const p = Object.assign({}, base, {
      prospect_id: id,
      // valeurs par défaut si le scoring ne les a pas fournies
      statut: texte(base.statut) || (texte(base.motif_exclusion) ? 'exclu' : 'a_contacter'),
      etape_actuelle: Number(base.etape_actuelle || 0),
      dernier_contact: base.dernier_contact || null,
      nb_appels: Number(base.nb_appels || 0),
      email_journal: [],
      cree_le: maintenantIso,
      maj_le: maintenantIso,
    });
    db.prospects[id] = p;
    return { id, action: 'cree' };
  }

  // ⚠️ On met à jour les FAITS, jamais l'avancement de la séquence.
  // Sinon un sourcing quotidien remettrait tout le monde en "a_contacter"
  // et les mêmes hôtels recevraient le même email chaque matin.
  for (const c of CHAMPS_FACTUELS) {
    if (base[c] !== undefined && base[c] !== null && base[c] !== '') existant[c] = base[c];
  }
  if (base.statut && !EN_COURS.includes(existant.statut) && existant.statut === 'exclu' && EN_COURS.includes(base.statut)) {
    existant.statut = base.statut; // un prospect qu'on avait exclu et qui redevient valable
  }
  existant.maj_le = maintenantIso;
  return { id, action: 'maj' };
}

function listeProspects(filtreStatut) {
  const tous = Object.values(db.prospects);
  const f = texte(filtreStatut);
  let sortie = tous;
  if (f && f !== 'all') {
    const demandes = f === 'en_cours' ? EN_COURS : f.split(',').map((s) => s.trim()).filter(Boolean);
    sortie = tous.filter((p) => demandes.includes(String(p.statut || '')));
  }
  // les plus intéressants d'abord
  return sortie.sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)) || String(a.nom).localeCompare(String(b.nom)));
}

function exportCsv() {
  const cols = ['prospect_id', 'priorite', 'score', 'nom', 'ville', 'telephone', 'email', 'site',
    'note', 'nb_avis', 'canal_principal', 'statut', 'etape_actuelle', 'dernier_contact', 'nb_appels', 'angle'];
  const ech = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
  const lignes = [cols.join(',')].concat(
    listeProspects('all').map((p) => cols.map((c) => ech(p[c])).join(',')));
  return '\uFEFF' + lignes.join('\r\n') + '\r\n';
}

function ajouterSuppression(brut) {
  const email = texte(brut.email).toLowerCase();
  const telephone = texte(brut.telephone).replace(/[^\d+]/g, '');
  if (!email && !telephone) return { action: 'ignore', raison: 'ni email ni telephone' };
  const deja = db.suppression.some((s) =>
    (email && String(s.email || '').toLowerCase() === email) ||
    (telephone && String(s.telephone || '') === telephone));
  if (deja) return { action: 'deja_present' };
  db.suppression.push({
    email, telephone,
    motif: texte(brut.motif) || texte(brut.categorie) || 'stop',
    prospect_id: texte(brut.prospect_id),
    source: texte(brut.source) || 'prospection',
    cree_le: maintenant(),
  });
  const p = db.prospects[texte(brut.prospect_id)];
  if (p) { p.statut = 'stop'; p.maj_le = maintenant(); }
  return { action: 'ajoute' };
}

// ------------------------------------------------------------ serveur
charger();

const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://ledger.local');
  const chemin = url.pathname.replace(/\/+$/, '') || '/';
  const methode = (req.method || 'GET').toUpperCase();

  if (methode === 'OPTIONS') return envoyer(res, 204, '');

  if (chemin === '/health') {
    return envoyer(res, 200, {
      ok: true, service: 'journal-prospection', version: 1,
      prospects: Object.keys(db.prospects).length,
      suppression: db.suppression.length,
      events: db.events.length,
      reports: db.reports.length,
      auth: TOKEN ? 'jeton actif' : 'AUCUN JETON (ouvert)',
      heure: maintenant(),
    });
  }

  if (!autorise(req, url)) {
    console.log(`[ledger] 401 ${methode} ${chemin}`);
    return envoyer(res, 401, { error: 'jeton absent ou invalide' });
  }

  try {
    // ---------------- GET
    if (methode === 'GET' && chemin === '/prospects') {
      return envoyer(res, 200, listeProspects(url.searchParams.get('statut') || 'all'));
    }
    if (methode === 'GET' && chemin === '/prospects/export.csv') {
      return envoyer(res, 200, exportCsv(), 'text/csv; charset=utf-8');
    }
    if (methode === 'GET' && chemin === '/suppression') {
      return envoyer(res, 200, db.suppression);
    }
    if (methode === 'GET' && chemin === '/events') {
      const n = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
      return envoyer(res, 200, db.events.slice(-n));
    }
    if (methode === 'GET' && chemin === '/reports') {
      return envoyer(res, 200, db.reports.slice(-50));
    }
    const mGet = chemin.match(/^\/prospects\/([^/]+)$/);
    if (methode === 'GET' && mGet) {
      const p = db.prospects[decodeURIComponent(mGet[1])];
      return p ? envoyer(res, 200, p) : envoyer(res, 404, { error: 'prospect inconnu' });
    }

    // ---------------- POST
    if (methode === 'POST' && chemin === '/prospects/bulk') {
      const corps = await lireBody(req);
      const items = Array.isArray(corps) ? corps : (Array.isArray(corps.prospects) ? corps.prospects : [corps]);
      const resultat = { recus: items.length, crees: 0, maj: 0, ids: [] };
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const r = upsert(it);
        if (r.action === 'cree') resultat.crees += 1; else resultat.maj += 1;
        resultat.ids.push(r.id);
      }
      db.events.push({ type: 'sourcing', recus: resultat.recus, crees: resultat.crees, maj: resultat.maj, recu_le: maintenant() });
      if (db.events.length > MAX_EVENTS) db.events = db.events.slice(-MAX_EVENTS);
      sauver();
      console.log(`[ledger] bulk : ${resultat.crees} créés, ${resultat.maj} mis à jour`);
      return envoyer(res, 200, Object.assign({ ok: true }, resultat));
    }

    if (methode === 'POST' && chemin === '/events') {
      const corps = await lireBody(req);
      db.events.push(Object.assign({}, corps, { recu_le: maintenant() }));
      if (db.events.length > MAX_EVENTS) db.events = db.events.slice(-MAX_EVENTS);
      sauver();
      return envoyer(res, 200, { ok: true, events: db.events.length });
    }

    if (methode === 'POST' && chemin === '/reports') {
      const corps = await lireBody(req);
      db.reports.push(Object.assign({}, corps, { recu_le: maintenant() }));
      if (db.reports.length > MAX_REPORTS) db.reports = db.reports.slice(-MAX_REPORTS);
      sauver();
      return envoyer(res, 200, { ok: true });
    }

    if (methode === 'POST' && chemin === '/suppression') {
      const corps = await lireBody(req);
      const r = ajouterSuppression(corps);
      db.events.push(Object.assign({ type: 'suppression', action: r.action }, corps, { recu_le: maintenant() }));
      sauver();
      console.log(`[ledger] suppression : ${r.action}`);
      return envoyer(res, 200, Object.assign({ ok: true }, r));
    }

    const mEtape = chemin.match(/^\/prospects\/([^/]+)\/etape$/);
    if (methode === 'POST' && mEtape) {
      const id = decodeURIComponent(mEtape[1]);
      const corps = await lireBody(req);
      const p = db.prospects[id];
      if (!p) return envoyer(res, 404, { error: 'prospect inconnu', prospect_id: id });
      p.etape_actuelle = Number(corps.etape || p.etape_actuelle || 0);
      p.dernier_contact = corps.envoye_le || maintenant();
      p.statut = texte(corps.statut) || 'en_sequence';
      if (texte(corps.canal) === 'appel') p.nb_appels = Number(p.nb_appels || 0) + 1;
      if (texte(corps.email_journal)) {
        p.email_journal = Array.isArray(p.email_journal) ? p.email_journal : [];
        p.email_journal.push({ email: corps.email_journal, sujet: texte(corps.sujet), le: p.dernier_contact });
      }
      p.maj_le = maintenant();
      sauver();
      return envoyer(res, 200, { ok: true, prospect_id: id, etape_actuelle: p.etape_actuelle, statut: p.statut });
    }

    const mStatut = chemin.match(/^\/prospects\/([^/]+)\/statut$/);
    if (methode === 'POST' && mStatut) {
      const id = decodeURIComponent(mStatut[1]);
      const corps = await lireBody(req);
      const p = db.prospects[id];
      if (!p) return envoyer(res, 404, { error: 'prospect inconnu', prospect_id: id });
      p.statut = texte(corps.statut) || p.statut;
      if (texte(corps.raison)) p.raison = texte(corps.raison);
      p.maj_le = maintenant();
      sauver();
      return envoyer(res, 200, { ok: true, prospect_id: id, statut: p.statut });
    }

    // ---------------- 404
    return envoyer(res, 404, { error: 'route inconnue', methode, chemin });
  } catch (e) {
    console.error('[ledger] erreur :', e.message);
    return envoyer(res, 400, { error: e.message });
  }
});

serveur.listen(PORT, '0.0.0.0', () => {
  console.log(`[ledger] à l'écoute sur 0.0.0.0:${PORT} · données : ${DATA_FILE}`);
  if (!TOKEN) console.warn('[ledger] ⚠️  LEDGER_TOKEN non défini : toute personne connaissant l\'URL peut lire et écrire.');
});

process.on('SIGTERM', () => { sauver(); process.exit(0); });
process.on('SIGINT', () => { sauver(); process.exit(0); });
