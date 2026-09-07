/**
 * BRL Command Center — minimal backend
 * - Serves the static app (public/index.html) behind a login page (public/login.html)
 * - Provides a 3-key KV API (brl-leads, brl-activity, brl-settings) backed by JSON files
 * - Session-based auth (two users: suyashh, jagruti) — no browser Basic-Auth popup
 * - Writes a dated backup snapshot once per day on any write
 *
 * Run: node server.js   (or, in production: pm2 start server.js --name brl-cc)
 */
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4001;

const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---- Users --------------------------------------------------------------
// Set real passwords via .env — CHANGE THESE before deploying.
const bcrypt = require('bcryptjs');
const users = {
  suyashh: process.env.PASS_SUYASHH || 'change-me-suyashh',
  jagruti: process.env.PASS_JAGRUTI || 'change-me-jagruti',
};
const ADMIN_USER = 'suyashh'; // only this account can manage other users

// ---- Additional users (managed from Settings by the admin) ----------------
// The two accounts above stay exactly as they are (set via .env). Anyone
// created through the app's UI lives here instead, with a hashed password —
// never plaintext on disk.
function usersFilePath() {
  return path.join(DATA_DIR, 'brl-users.json');
}
function readExtraUsers() {
  try {
    return JSON.parse(fs.readFileSync(usersFilePath(), 'utf8'));
  } catch (e) {
    return [];
  }
}
function writeExtraUsers(list) {
  fs.writeFileSync(usersFilePath(), JSON.stringify(list, null, 2), 'utf8');
}

// ---- Session setup --------------------------------------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'brl-cc-please-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);
app.set('trust proxy', 1); // we sit behind nginx

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // for the login form POST

// ---- Login / logout routes (unprotected) ---------------------------------
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (username && users[username] && users[username] === password) {
    req.session.user = username;
    return res.redirect('/');
  }
  if (username && password) {
    const extra = readExtraUsers().find(u => u.username === username);
    if (extra && (await bcrypt.compare(password, extra.passwordHash))) {
      req.session.user = username;
      return res.redirect('/');
    }
  }
  res.redirect('/login?error=1');
});



app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- Auth gate for everything else ---------------------------------------
const PUBLIC_ASSETS = new Set(['/manifest.json', '/icon-192.png', '/icon-512.png', '/sw.js']);
function requireAuth(req, res, next) {
  if (PUBLIC_ASSETS.has(req.path)) return next(); // needed for the browser's install-app prompt to work
  if (req.path.startsWith('/generated/')) return next(); // generated PDFs must be openable by email/WhatsApp recipients, who have no session
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not logged in' });
  return res.redirect('/login');
}
app.use(requireAuth);

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user, isAdmin: req.session.user === ADMIN_USER });
});

// ---- WhatsApp send proxy (bypasses browser CORS; keeps the request server-to-server) ----
// Only forwards to the two known WhatsApp provider hosts — never an open relay.
const WA_ALLOWED_HOSTS = new Set(['api.maytapi.com', 'app.messageautosender.com']);
const fetchFn = globalThis.fetch || require('node-fetch');

app.post('/api/wa-proxy', async (req, res) => {
  try {
    const { url, headers, body } = req.body || {};
    if (typeof url !== 'string') return res.status(400).json({ error: 'missing url' });
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'bad url' });
    }
    if (!WA_ALLOWED_HOSTS.has(parsed.hostname)) {
      return res.status(400).json({ error: 'host not allowed: ' + parsed.hostname });
    }
    const upstream = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body || {}),
    });
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'text/plain').send(text);
  } catch (e) {
    res.status(502).json({ error: 'proxy failed', detail: String(e) });
  }
});

// ---- Profile PDF generator -------------------------------------------------
// Matches the real Best Roadways one-pager format (fixed structure/colors,
// content varies by industry). Colors sampled directly from the provided
// sample PDFs: brand red #E31E25, footer black #111111, callout pink #FBEAEA.
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const GENERATED_DIR = path.join(__dirname, 'public', 'generated');
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

const RED = '#E31E25';
const BLACK_FOOTER = '#111111';
const CALLOUT_PINK = '#FBEAEA';
const INK = '#1A1A1A';
const GRAY = '#555555';

// Fixed facts — same across every proposal, matches the real samples exactly.
const STATS = [
  { n: '800+', l: 'OWNED TRUCKS' },
  { n: '65+', l: 'BRANCHES PAN-INDIA' },
  { n: 'Rs. 650 Cr', l: 'ANNUAL REVENUE' },
  { n: '7.5 Lakh', l: 'SQ FT BONDED WH, JNPT' },
];

// One content block per industry — kicker/headline/intro/pillars/scope/why/
// callout/proof/CTA, in the same voice as the real Asian Paints & EPACK
// samples. 'chemicals' and 'manufacturing' are adapted closely from those
// two real samples; the rest are original copy written in the same style
// for industries no sample was provided for.
const PLAYBOOK = {
  chemicals: {
    kicker: 'CHEMICALS & COATINGS',
    headline: co => `Freight That Keeps ${co || 'Your Plants'} Moving Safely`,
    intro: co => `${co || 'Your business'} runs on freight that has to match its safety standards: solvent-based and Class 3 flammable cargo moving from plant to distribution network without compromise. That is exactly the freight profile Best Roadways has run for 40 years — high-volume, safety-critical FTL on an owned-first fleet.`,
    pillars: [
      { t: 'Plant-to-RDC Linehaul', b: 'Dedicated FTL capacity from your plants into regional distribution centres — consistent placement through season peaks.' },
      { t: 'Flammable-Cargo Discipline', b: 'Hazchem-trained drivers, licensed vehicles, TREM-card compliance and spill protocols for solvent-based and chemical cargo.' },
      { t: 'Inbound Raw Material Legs', b: 'Monomers, solvents, packaging and pigments from JNPT and supplier clusters into plants, backed by bonded warehousing at the port.' },
    ],
    scope: ['6W to 22W FTL — plant to RDC and depot linehaul', 'Class 3 flammable-liquid movements, fully compliant', 'Inbound solvent / monomer / packaging legs to plants', 'Bonded & general warehousing at JNPT for imports', 'Seasonal surge capacity ahead of peak demand'],
    why: ['Owned-first fleet of 800+ trucks — placement you control, not the spot market', '65+ branches for real ground presence on every lane', '40 years of chemical-sector FTL without compromise on safety', 'Single point of accountability from indent to POD'],
    callout: { lead: 'Season-proof placement:', body: ' peak-quarter demand breaks spot-market reliability every year. An owned-first fleet holds capacity on your lanes when the market tightens.' },
    proof: 'Best Roadways moves freight for Sudarshan Chemical, BASF, Lanxess, Michelman and Evonik — pigments, resins and coating inputs are daily cargo.',
    cta: 'Pick one plant-to-RDC lane this quarter. Give us one lane. We\'ll prove it.',
  },
  manufacturing: {
    kicker: 'MANUFACTURING & INDUSTRIAL',
    headline: co => `Your Production Line Shouldn't Wait on Freight`,
    intro: co => `${co || 'Your operation'} runs on tight production and dispatch schedules — raw material inbound and finished goods outbound have to move on time, every time. That is exactly the job Best Roadways' owned-first fleet of 800+ trucks does every day. This is a proposal to do it for ${co || 'you'}.`,
    pillars: [
      { t: 'Plant-to-Site FTL', b: 'Dedicated capacity from your plants to sites and depots nationwide — lashed, protected, sequenced to your schedule.' },
      { t: 'Growth-Ready Capacity', b: 'As your production ramps up, our owned-first fleet scales lane-by-lane with your dispatch volumes — no spot-market scramble.' },
      { t: 'Export & Inbound Legs', b: 'Road corridors for your export book, plus inbound raw material movements to plants, backed by bonded warehousing at JNPT.' },
    ],
    scope: ['Industrial & project cargo FTL — 6W to 22W', 'Plant outbound, pan-India', 'Site-timed deliveries against production schedules', 'Export corridors on request', 'Inbound raw material legs'],
    why: ['Owned-first fleet of 800+ trucks — capacity that scales with your ramp-up', '65+ branches for deep regional lane coverage', '40 years of industrial and manufacturing-sector freight', 'Single point of accountability from indent to POD'],
    callout: { lead: 'On-time is the brand:', body: ' a production schedule means nothing if inputs or outputs are late. A carrier that delivers to your sequence protects the promise you sell to your customers.' },
    proof: 'Best Roadways moves freight for Owens-Corning, Asahi India Glass, Jindal Aluminium, Sika and Fosroc — construction and industrial-material freight delivered on sequence.',
    cta: 'Start with one plant-to-site corridor. Give us one lane. We\'ll prove it.',
  },
  pharma: {
    kicker: 'PHARMA & LIFE SCIENCES',
    headline: co => `Compliance-First Freight for ${co || 'Life Sciences'}`,
    intro: co => `${co || 'Your business'} operates under documentation and handling standards that don't leave room for error. That is exactly the discipline Best Roadways has built into 40 years of asset-owned FTL — reliable, compliant, and accountable end to end.`,
    pillars: [
      { t: 'Plant-to-Distribution FTL', b: 'Dedicated capacity from manufacturing sites into distribution centres, with consistent placement and documentation discipline.' },
      { t: 'Compliance-Ready Handling', b: 'Trained drivers and licensed vehicles for regulated cargo, with full chain-of-custody documentation on every movement.' },
      { t: 'Inbound Raw Material Legs', b: 'API and packaging inbound from ports and supplier clusters, backed by bonded warehousing at JNPT.' },
    ],
    scope: ['6W to 22W FTL — plant to distribution centre', 'Regulated and compliance-sensitive cargo handling', 'Inbound API / packaging / raw material legs', 'Bonded & general warehousing at JNPT for imports', 'Full movement documentation on request'],
    why: ['Owned-first fleet of 800+ trucks — placement you control, not the spot market', '65+ branches for real ground presence on every lane', '40 years of compliance-first FTL operating history', 'Single point of accountability from indent to POD'],
    callout: { lead: 'Compliance is not negotiable:', body: ' one undocumented movement can cost more than a year of savings from a cheaper carrier. Reliability and paperwork discipline are the actual product here.' },
    proof: 'Best Roadways moves freight for leading chemical and life-sciences manufacturers — regulated cargo handled with the documentation discipline the sector requires.',
    cta: 'Pick one lane to pilot. Give us one lane. We\'ll prove it.',
  },
  automotive: {
    kicker: 'AUTOMOTIVE & COMPONENTS',
    headline: co => `Freight That Keeps ${co || 'Your Line'} Running`,
    intro: co => `${co || 'Your plant'} runs on JIT schedules where a late truck stops a production line. That is exactly the reliability profile Best Roadways has built for 40 years of asset-owned FTL — placement you control, not the spot market.`,
    pillars: [
      { t: 'Plant-to-Plant JIT FTL', b: 'Dedicated capacity tuned to production schedules — components and sub-assemblies delivered on your window, not the market\'s.' },
      { t: 'Growth-Ready Capacity', b: 'As volumes ramp with new model launches, our owned-first fleet scales lane-by-lane without spot-market scrambling.' },
      { t: 'Finished Vehicle & Inbound Legs', b: 'Component inbound and finished-goods outbound on the same accountable fleet, backed by bonded warehousing at JNPT.' },
    ],
    scope: ['6W to 22W FTL — plant to plant, JIT scheduling', 'Component and sub-assembly movement', 'Finished goods outbound, pan-India', 'Inbound raw material and component legs', 'Bonded warehousing at JNPT for imports'],
    why: ['Owned-first fleet of 800+ trucks — capacity that scales with your ramp-up', '65+ branches for deep regional lane coverage', '40 years of JIT-discipline FTL operating history', 'Single point of accountability from indent to POD'],
    callout: { lead: 'A late truck stops a line:', body: ' JIT manufacturing has zero slack for spot-market unreliability. An owned-first fleet holds your schedule, not just your cargo.' },
    proof: 'Best Roadways moves freight for leading automotive and component manufacturers — schedule-critical cargo delivered on sequence.',
    cta: 'Pick one plant-to-plant lane this quarter. Give us one lane. We\'ll prove it.',
  },
  fmcg: {
    kicker: 'FMCG & CONSUMER GOODS',
    headline: co => `Keeping ${co || 'Your Shelves'} Stocked, Every Season`,
    intro: co => `${co || 'Your distribution network'} runs on high-frequency dispatch where a missed delivery window means an empty shelf. That is exactly the reliability Best Roadways has built for 40 years of asset-owned FTL operations.`,
    pillars: [
      { t: 'Plant-to-RDC Linehaul', b: 'High-frequency FTL capacity from plants into regional distribution centres, holding through festive and seasonal peaks.' },
      { t: 'Peak-Season Reliability', b: 'Dedicated lane allocation means no spot-market scramble when demand spikes hardest.' },
      { t: 'Inbound Raw Material Legs', b: 'Packaging and raw material inbound from ports and supplier clusters, backed by bonded warehousing at JNPT.' },
    ],
    scope: ['6W to 22W FTL — plant to RDC linehaul', 'High-frequency, high-volume dispatch capability', 'Peak-season surge capacity', 'Inbound packaging / raw material legs', 'Bonded warehousing at JNPT for imports'],
    why: ['Owned-first fleet of 800+ trucks — placement you control, not the spot market', '65+ branches for real ground presence on every lane', '40 years of high-volume FTL operating history', 'Single point of accountability from indent to POD'],
    callout: { lead: 'Season-proof placement:', body: ' festive-quarter demand breaks spot-market reliability every year. An owned-first fleet holds capacity on your lanes when the market tightens.' },
    proof: 'Best Roadways moves freight for leading FMCG and consumer-goods manufacturers — high-frequency dispatch handled without compromise.',
    cta: 'Pick one plant-to-RDC lane this quarter. Give us one lane. We\'ll prove it.',
  },
  energy: {
    kicker: 'OIL & GAS / EPC / INFRASTRUCTURE',
    headline: co => `Your Projects Build India's Energy Backbone${co ? ', ' + co : ''}. We Keep Them Fed.`,
    intro: co => `${co || 'Your business'} builds what India's energy economy runs on — refinery units, terminals, tank farms, pipelines and fire-protection systems, fed by a continuous stream of steel, piping, fabricated structures and equipment. That stream is exactly what Best Roadways' owned-first FTL is built to carry.`,
    pillars: [
      { t: 'Site-Feed Project FTL', b: 'Steel plates, piping spools, fabricated structures, valves and equipment from vendors and yards to your project sites across India — placed against your construction schedule.' },
      { t: 'Multi-Site, One Partner', b: 'Refinery, terminal and pipeline sites running in parallel across states; our 65+ branches give you one accountable carrier and one control tower.' },
      { t: 'Vendor-Pickup Discipline', b: 'Milk-run pickups across your fabricator and supplier base, consolidated and delivered site-wise — less coordination load on your project managers.' },
    ],
    scope: ['Project cargo FTL — steel, piping, structures, equipment (6W to 22W)', 'Vendor / yard pickups to project sites pan-India', 'Time-bound deliveries against construction milestones', 'Bonded & general warehousing at JNPT for imported equipment', 'Site consumables and shutdown-material movements'],
    why: ['Owned-first fleet of 800+ trucks — placement that holds through project peaks', '65+ branches for real ground presence on every site', '40 years serving India\'s industrial and energy supply chains', 'Single accountability from indent to site POD'],
    callout: { lead: 'LD clocks don\'t wait for trucks:', body: ' on EPC sites, a late consignment costs crane hire, idle crews and liquidated-damages exposure. An owned-first carrier is schedule insurance your project managers will feel on day one.' },
    proof: 'Best Roadways moves freight for Indian Oil (Panipat), GS Caltex, Sika, Fosroc and Metso — oil & gas and project-site cargo is our daily work.',
    cta: 'Give us one project site to prove. Give us one lane. We\'ll prove it.',
  },
  default: {
    kicker: 'FULL-TRUCKLOAD ROAD LOGISTICS',
    headline: co => `Freight ${co ? 'for ' + co : ''} on Committed Capacity, Not the Spot Market`,
    intro: co => `${co || 'Your business'} deserves an asset-heavy FTL transporter built for India's intercity freight. We run our own fleet, our own network and our own people — so your goods move on committed capacity, not the spot market.`,
    pillars: [
      { t: 'Intercity Line-Haul', b: 'Depot-to-depot full-truckload movement — the long-haul leg that feeds your distribution network, on predictable transit times.' },
      { t: 'Owned Fleet, Not a Brokerage', b: '800+ owned trucks means committed, reliable capacity you can plan around — season after season.' },
      { t: 'Bonded Warehousing', b: '7.5 lakh sq ft of bonded warehousing at Nhava Sheva / JNPT, supporting import-linked freight movements.' },
    ],
    scope: ['32-ft FTL fleet for high-volume intercity lanes', 'Depot transfers & line-haul — mother WH to city DC', 'Container movement — thousands handled monthly', 'Bonded warehousing at Nhava Sheva / JNPT', 'Pan-India reach across 65+ owned branches'],
    why: ['Owned fleet, not a brokerage — committed, reliable capacity', 'No peak-season surprises — dedicated lane allocation', '40-year track record with blue-chip shippers', 'Branch-level execution at both origin & destination'],
    callout: { lead: 'Sustainability, at zero cost to you:', body: ' through our MoU with MGL, we absorb the CNG retrofit capex — so converting your lanes to cleaner CNG becomes a green win on your ESG scorecard, not a cost line.' },
    proof: 'Best Roadways moves freight for Waaree Energies, Tata Consumer Products, Corteva, Rallis India, Syngenta, Evonik, Dow Chemical, Asian Paints PPG and Kokuyo Camlin.',
    cta: 'Give us one lane. We\'ll prove it.',
  },
};
// Each category matches on any of several real-world phrasings, not just its
// own key — this is what was broken: typing 'Paints' or 'Oil & Gas' matched
// nothing before, so it silently fell back to the generic default every time.
const INDUSTRY_SYNONYMS = {
  chemicals: ['chemical', 'coating', 'paint', 'solvent', 'pigment', 'resin', 'dye'],
  manufacturing: ['manufactur', 'industrial', 'peb', 'pre-engineered', 'preengineered', 'panel', 'steel', 'construction'],
  pharma: ['pharma', 'life science', 'healthcare', 'medicine', 'biotech'],
  automotive: ['auto', 'vehicle', 'component', 'oem', 'ancillary'],
  fmcg: ['fmcg', 'consumer good', 'retail', 'food', 'beverage', 'fast moving'],
  energy: ['energy', 'oil', 'gas', 'epc', 'infrastructure', 'power', 'solar', 'renewable', 'offshore', 'refinery', 'pipeline', 'petrochem'],
};
function playbookFor(industry) {
  const key = String(industry || '').toLowerCase().trim();
  if (!key) return PLAYBOOK.default;
  for (const cat of Object.keys(INDUSTRY_SYNONYMS)) {
    if (INDUSTRY_SYNONYMS[cat].some(word => key.includes(word))) return PLAYBOOK[cat];
  }
  return PLAYBOOK.default;
}

function spacedCaps(s) {
  return s.toUpperCase();
}

const HEADER_IMG = path.join(__dirname, 'assets', 'brl-header.png');
const FOOTER_SEAL_IMG = path.join(__dirname, 'assets', 'brl-footer-seal.png');

function drawHeader(doc) {
  const w = doc.page.width;
  const hw = w - 80; // 40pt margin each side
  const hh = hw * (226 / 1250); // preserve the real logo's aspect ratio
  doc.image(HEADER_IMG, 40, 20, { width: hw, height: hh });
  return hh; // caller needs this to position everything below correctly
}

function buildProfilePdf({ co, name, industry }) {
  const pb = playbookFor(industry);
  const id = crypto.randomBytes(9).toString('hex');
  const filePath = path.join(GENERATED_DIR, id + '.pdf');
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  const W = doc.page.width;
  const M = 40; // left/right content margin
  const CW = W - M * 2;

  const headerH = drawHeader(doc);

  // Kicker band
  let y = 20 + headerH + 10;
  doc.rect(0, y, W, 22).fill(RED);
  doc.fillColor('#FFFFFF').fontSize(7.5).font('Helvetica-Bold')
    .text(spacedCaps(pb.kicker + ' • FTL LOGISTICS PROPOSAL'), M, y + 7, { width: CW, characterSpacing: 0.6 });
  y += 34;

  // Headline
  doc.fillColor(INK).fontSize(19).font('Helvetica-Bold');
  doc.text(pb.headline(co), M, y, { width: CW });
  y = doc.y + 8;

  // Intro paragraph
  doc.fillColor(GRAY).fontSize(10.3).font('Helvetica');
  doc.text(pb.intro(co), M, y, { width: CW, lineGap: 2 });
  y = doc.y + 14;

  // Stat bar
  const statW = CW / 4;
  const statH = 46;
  STATS.forEach((s, i) => {
    const x = M + i * statW;
    doc.rect(x, y, statW - 4, statH).fill(RED);
    doc.fillColor('#FFFFFF').fontSize(15).font('Helvetica-Bold').text(s.n, x, y + 8, { width: statW - 4, align: 'center' });
    doc.fontSize(6.5).font('Helvetica-Bold').text(s.l, x + 4, y + 30, { width: statW - 12, align: 'center' });
  });
  y += statH + 16;

  // 3 pillar cards
  const pillarW = CW / 3;
  const pillarH = 78;
  pb.pillars.forEach((p, i) => {
    const x = M + i * pillarW;
    doc.rect(x, y, pillarW - 8, pillarH).lineWidth(1).stroke('#E0E0E0');
    doc.fillColor(RED).fontSize(13).font('Helvetica-Bold').text('0' + (i + 1), x + 8, y + 8);
    doc.fillColor(INK).fontSize(9.5).font('Helvetica-Bold').text(p.t, x + 8, y + 26, { width: pillarW - 20 });
    doc.fillColor(GRAY).fontSize(8).font('Helvetica').text(p.b, x + 8, doc.y + 3, { width: pillarW - 20, lineGap: 1 });
  });
  y += pillarH + 16;

  // Two-column: Scope of Services | Why Best Roadways
  const colW = CW / 2 - 10;
  function bulletList(title, items, x) {
    doc.fillColor(RED).fontSize(9.5).font('Helvetica-Bold').text(spacedCaps(title), x, y, { width: colW, characterSpacing: 0.4 });
    doc.moveTo(x, doc.y + 2).lineTo(x + 50, doc.y + 2).lineWidth(1.5).stroke(RED);
    let iy = doc.y + 8;
    items.forEach(it => {
      doc.fillColor(RED).rect(x, iy + 2, 4, 4).fill(RED);
      doc.fillColor(GRAY).fontSize(8.3).font('Helvetica').text(it, x + 10, iy, { width: colW - 10, lineGap: 1 });
      iy = doc.y + 4;
    });
    return iy;
  }
  const leftEnd = bulletList('Scope of Services', pb.scope, M);
  const rightEnd = bulletList('Why Best Roadways', pb.why, M + colW + 20);
  y = Math.max(leftEnd, rightEnd) + 10;

  // Callout box
  doc.rect(M, y, CW, 0).fill(); // no-op to reset fill state
  const calloutTextH = doc.heightOfString(pb.callout.lead + pb.callout.body, { width: CW - 30, fontSize: 9 });
  const calloutH = calloutTextH + 20;
  doc.rect(M, y, CW, calloutH).fill(CALLOUT_PINK);
  doc.rect(M, y, 4, calloutH).fill(RED);
  doc.fillColor(RED).fontSize(9).font('Helvetica-Bold').text(pb.callout.lead, M + 15, y + 10, { width: CW - 30, continued: true });
  doc.fillColor(INK).font('Helvetica').text(pb.callout.body, { width: CW - 30 });
  y += calloutH + 12;

  // Proof banner
  const proofTextH = doc.heightOfString(pb.proof, { width: CW - 30, fontSize: 10, font: 'Helvetica-Bold' });
  const proofH = proofTextH + 30;
  doc.rect(M, y, CW, proofH).fill(RED);
  doc.fillColor('#FFFFFF').fontSize(7.5).font('Helvetica-Bold').text(spacedCaps('PROVEN IN YOUR SECTOR'), M + 15, y + 10, { width: CW - 30, characterSpacing: 0.6 });
  doc.fontSize(10).font('Helvetica-Bold').text(pb.proof, M + 15, doc.y + 4, { width: CW - 30 });
  y += proofH + 12;

  // CTA
  doc.fillColor(INK).fontSize(10.5).font('Helvetica-Bold').text(pb.cta, M, y, { width: CW });
  y = doc.y + 10;

  // Personal note (this is the one truly per-lead touch, keeps a human contact point)
  doc.fillColor(GRAY).fontSize(9).font('Helvetica')
    .text('Prepared for ' + (name || 'you') + (co ? ' at ' + co : '') + ' — happy to walk through any of this on a short call.', M, y, { width: CW });

  // Footer
  const fy = doc.page.height - 70;
  doc.rect(0, fy, W, 70).fill(BLACK_FOOTER);
  doc.image(FOOTER_SEAL_IMG, 42, fy + 13, { width: 44, height: 44 });
  doc.fillColor('#FFFFFF').fontSize(9.5).font('Helvetica-Bold').text('Suyashh Gupta', M + 55, fy + 15);
  doc.fontSize(7.5).font('Helvetica').fillColor('#CCCCCC')
    .text('Director – Strategy, Tech & Sales · Best Roadways Limited, Andheri East, Mumbai', M + 55, fy + 29, { width: 260 });
  doc.fillColor(RED).fontSize(8).font('Helvetica-Bold').text('sg@bestroadways.com', W - 240, fy + 15, { width: 200, align: 'right' });
  doc.fillColor('#CCCCCC').fontSize(8).font('Helvetica').text('+91 95949 64689 · www.bestroadways.com', W - 240, fy + 29, { width: 200, align: 'right' });

  doc.end();
  return { id, filePath, stream };
}

app.post('/api/profile-pdf', (req, res) => {
  const { co, name, industry } = req.body || {};
  const { id, stream } = buildProfilePdf({ co, name, industry });

  stream.on('finish', () => {
    res.json({ url: '/generated/' + id + '.pdf' });
  });
  stream.on('error', (e) => {
    res.status(500).json({ error: 'PDF generation failed', detail: String(e) });
  });
});

// ---- Real email send with genuine attachment (not a link) -----------------
// mailto: cannot attach files at all — this is what makes a true attachment
// possible. Needs SMTP credentials set in Settings → Email sending.
const nodemailer = require('nodemailer');
function buildTransporter(settings) {
  const { smtpHost, smtpPort, smtpUser, smtpPass } = settings;
  if (!smtpHost || !smtpUser || !smtpPass) return null;
  return nodemailer.createTransport({
    host: smtpHost,
    port: Number(smtpPort) || 587,
    secure: Number(smtpPort) === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });
}

app.post('/api/send-profile-email', async (req, res) => {
  const { to, cc, subject, body, co, name, industry } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Recipient email (to) is required' });

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(keyPath('brl-settings'), 'utf8'));
  } catch (e) {
    /* no settings saved yet */
  }
  const transporter = buildTransporter(settings);
  if (!transporter) {
    return res.status(400).json({ error: 'Email sending isn\'t set up yet — add SMTP details in Settings → Email sending.' });
  }
  const { smtpUser, smtpFrom } = settings;

  let filePath;
  try {
    const built = buildProfilePdf({ co, name, industry });
    filePath = built.filePath;
    await new Promise((resolve, reject) => {
      built.stream.on('finish', resolve);
      built.stream.on('error', reject);
    });
  } catch (e) {
    return res.status(500).json({ error: 'PDF generation failed', detail: String(e) });
  }

  try {
    await transporter.sendMail({
      from: smtpFrom || smtpUser,
      to,
      cc: cc || undefined,
      subject: subject || 'Best Roadways Limited — Company Profile',
      text: body || '',
      attachments: [
        { filename: 'Best-Roadways-Profile.pdf', path: filePath, contentType: 'application/pdf' },
      ],
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'SMTP send failed', detail: String(e && e.message ? e.message : e) });
  }
});

// ---- Send profile PDF via WhatsApp (real document, both providers) --------
// Maytapi wants a public URL to the file; Message Auto Sender wants the raw
// file bytes, base64-encoded, in the request body itself (confirmed against
// their real API — very different from Maytapi's approach, not something a
// generic proxy could handle without knowing this ahead of time).
app.post('/api/send-profile-whatsapp', async (req, res) => {
  const { to, co, name, industry } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Recipient mobile number (to) is required' });

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(keyPath('brl-settings'), 'utf8'));
  } catch (e) {
    /* no settings saved yet */
  }
  const provider = settings.waProvider;
  const caption = 'Company profile for ' + (co || '') + ' — Best Roadways Limited';

  if (provider !== 'maytapi' && provider !== 'mas') {
    return res.status(400).json({ error: 'No WhatsApp provider selected — set "Send via" in Settings → WhatsApp to Maytapi or Message Auto Sender.' });
  }

  let filePath;
  try {
    const built = buildProfilePdf({ co, name, industry });
    filePath = built.filePath;
    await new Promise((resolve, reject) => {
      built.stream.on('finish', resolve);
      built.stream.on('error', reject);
    });
  } catch (e) {
    return res.status(500).json({ error: 'PDF generation failed', detail: String(e) });
  }

  try {
    if (provider === 'maytapi') {
      if (!settings.maytapiProduct || !settings.maytapiPhone || !settings.maytapiKey) {
        return res.status(400).json({ error: 'Maytapi fields are incomplete in Settings → WhatsApp.' });
      }
      const publicUrl = req.protocol + '://' + req.get('host') + '/generated/' + path.basename(filePath);
      const upstream = await fetch(
        'https://api.maytapi.com/api/' + settings.maytapiProduct + '/' + settings.maytapiPhone + '/sendMessage',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-maytapi-key': settings.maytapiKey },
          body: JSON.stringify({ to_number: to, type: 'media', message: publicUrl, text: caption }),
        }
      );
      const text = await upstream.text();
      if (!upstream.ok) return res.status(502).json({ error: 'Maytapi send failed', detail: text });
      return res.json({ ok: true, provider: 'maytapi' });
    }

    if (provider === 'mas') {
      if (!settings.masAuth) {
        return res.status(400).json({ error: 'Message Auto Sender Authorization value is empty in Settings → WhatsApp.' });
      }
      const base64Body = fs.readFileSync(filePath).toString('base64');
      const upstream = await fetch('https://app.messageautosender.com/api/v1/message/create', {
        method: 'POST',
        headers: { accept: 'application/json', Authorization: settings.masAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverMobileNo: to,
          base64File: [{ name: 'Best-Roadways-Profile.pdf', body: base64Body }],
        }),
      });
      const text = await upstream.text();
      if (!upstream.ok) return res.status(502).json({ error: 'Message Auto Sender send failed', detail: text });
      return res.json({ ok: true, provider: 'mas' });
    }
  } catch (e) {
    res.status(502).json({ error: 'WhatsApp send failed', detail: String(e && e.message ? e.message : e) });
  }
});


// ---- KV API ---------------------------------------------------------------
const ALLOWED_KEYS = new Set(['brl-leads', 'brl-activity', 'brl-settings']);

function keyPath(key) {
  return path.join(DATA_DIR, key + '.json');
}

function maybeBackup(key, value) {
  const today = new Date().toISOString().slice(0, 10);
  const fp = path.join(BACKUP_DIR, `${today}__${key}.json`);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, value, 'utf8');
  }
}

// ---- User management (admin only — suyashh account) ------------------------
function requireAdmin(req, res, next) {
  if (req.session.user !== ADMIN_USER) {
    return res.status(403).json({ error: 'Only the admin account can manage users.' });
  }
  next();
}

app.get('/api/users', requireAdmin, (req, res) => {
  const extra = readExtraUsers().map(u => ({ username: u.username }));
  const builtIn = Object.keys(users).map(username => ({ username, builtIn: true }));
  res.json({ users: [...builtIn, ...extra] });
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const clean = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(clean)) return res.status(400).json({ error: 'Username can only contain letters, numbers, dots, dashes, underscores.' });
  if (users[clean]) return res.status(400).json({ error: 'That username is already a built-in account.' });
  const extra = readExtraUsers();
  if (extra.some(u => u.username === clean)) return res.status(400).json({ error: 'That username already exists.' });
  const passwordHash = await bcrypt.hash(password, 10);
  extra.push({ username: clean, passwordHash });
  writeExtraUsers(extra);
  res.json({ ok: true, username: clean });
});

app.put('/api/users/:username/password', requireAdmin, async (req, res) => {
  const { username } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (users[username]) return res.status(400).json({ error: 'Built-in accounts (suyashh, jagruti) have their password set via .env on the server, not here.' });
  const extra = readExtraUsers();
  const u = extra.find(x => x.username === username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  u.passwordHash = await bcrypt.hash(password, 10);
  writeExtraUsers(extra);
  res.json({ ok: true });
});

app.delete('/api/users/:username', requireAdmin, (req, res) => {
  const { username } = req.params;
  if (users[username]) return res.status(400).json({ error: 'Built-in accounts can\'t be removed here.' });
  const extra = readExtraUsers();
  const next = extra.filter(x => x.username !== username);
  if (next.length === extra.length) return res.status(404).json({ error: 'User not found.' });
  writeExtraUsers(next);
  res.json({ ok: true });
});

// ---- Website inquiries (from a published-to-web Google Sheet CSV) ---------
// ---- Field Tasks (Google Sheet, read+write via Apps Script Web App) -------
app.get('/api/field-tasks', async (req, res) => {
  const settings = readJsonSafe('brl-settings', {});
  const url = settings.fieldTaskScriptUrl;
  if (!url) return res.status(400).json({ error: 'No Apps Script URL set in Settings → Field Tasks.' });
  try {
    const r = await fetchFn(url);
    const j = await r.json();
    if (!r.ok) return res.status(502).json(j);
    res.json(j);
  } catch (e) {
    res.status(502).json({ error: 'Fetch failed: ' + e.message });
  }
});
app.post('/api/field-tasks', async (req, res) => {
  const settings = readJsonSafe('brl-settings', {});
  const url = settings.fieldTaskScriptUrl;
  if (!url) return res.status(400).json({ error: 'No Apps Script URL set in Settings → Field Tasks.' });
  try {
    const r = await fetchFn(url, { method: 'POST', body: JSON.stringify(req.body) });
    const j = await r.json();
    if (!r.ok) return res.status(502).json(j);
    res.json(j);
  } catch (e) {
    res.status(502).json({ error: 'Save failed: ' + e.message });
  }
});

app.get('/api/website-inquiries', async (req, res) => {
  const settings = readJsonSafe('brl-settings', {});
  const url = settings.inquirySheetUrl;
  if (!url) return res.status(400).json({ error: 'No sheet URL set in Settings → Website Inquiry.' });
  try {
    const r = await fetchFn(url);
    if (!r.ok) return res.status(502).json({ error: 'Could not fetch the sheet (HTTP ' + r.status + ').' });
    const text = (await r.text()).replace(/\r\n/g, '\n');
    // Single-pass CSV parser — a newline only ends a row when we're NOT inside
    // a quoted field. Google Sheets cells with line breaks (multi-line notes)
    // are quoted, and a naive split('\n') breaks those into fake extra rows.
    const table = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); table.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur.length || row.length) { row.push(cur); table.push(row); }
    const nonEmpty = table.filter(r => r.some(v => v.trim().length));
    const headers = nonEmpty[0].map(h => h.trim());
    const rows = nonEmpty.slice(1).map(vals => {
      const o = {};
      headers.forEach((h, i) => o[h] = (vals[i] || '').trim());
      return o;
    });
    const parseTs = s => { // format is "D/M/YYYY, H:MM:SS" — NOT the US M/D/Y order, so new Date(s) alone silently fails
      const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):(\d{2})/);
      if (!m) return 0;
      const [, d, mo, y, h, mi, se] = m.map(Number);
      return new Date(y, mo - 1, d, h, mi, se).getTime();
    };
    rows.sort((a, b) => parseTs(b.Timestamp) - parseTs(a.Timestamp));
    res.json({ rows });
  } catch (e) {
    res.status(502).json({ error: 'Fetch failed: ' + e.message });
  }
});

app.get('/api/kv/:key', (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'unknown key' });
  const fp = keyPath(key);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  const value = fs.readFileSync(fp, 'utf8');
  res.json({ value });
});

app.put('/api/kv/:key', (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'unknown key' });
  const { value } = req.body || {};
  if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
  fs.writeFileSync(keyPath(key), value, 'utf8');
  maybeBackup(key, value);
  res.json({ ok: true });
});

// ---- Static app (protected — requireAuth already ran above) --------------
app.use(express.static(path.join(__dirname, 'public')));

// ---- Scheduled Morning/EOD notifications -----------------------------------
// Runs server-side (via cron) so it fires whether or not anyone has the app
// open. Mirrors the client's queues()/todayStats() logic — kept in sync by
// hand since this reads brl-leads.json/brl-activity.json directly rather than
// sharing code with the browser.
const cron = require('node-cron');

// Which outcomes count as "connected" — mirrors the client's OUTCOMES table,
// but only the one boolean this needs (avoids duplicating the whole table).
const CONN_OUTCOMES = new Set([
  '📆 Client asked to call back', '📄 RFQ received — rates needed', '📎 Asked for company profile',
  '🤝 Meeting fixed / done', '👉 Not concerned — referred someone', '📃 Contract finalized — reconnect later',
  '🏃 Person left company / retired', '💰 Rates shared — awaiting feedback', '🛄 Will share spot inquiries',
  '🏢 Vendor registration in process', '🎯 WON — first load received', '⛔ DEAD — no requirement / do not call',
]);

function readJsonSafe(key, fallback) {
  try {
    return JSON.parse(fs.readFileSync(keyPath(key), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function istNow() {
  // Server may run in any timezone (commonly UTC) — always compute "now" as if in IST.
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}
function istDateKey(d) {
  return d.toISOString().slice(0, 10); // d is already IST-shifted by istNow()
}
function istIsSaturday(d) {
  return d.getDay() === 6;
}

function computeQueueCounts() {
  const allLeads = readJsonSafe('brl-leads', []);
  const liveLeads = allLeads.filter(l => l.src === 'import' || l.src === 'manual');
  const now = istNow();
  const tk = istDateKey(now);
  const sat = istIsSaturday(now);
  let due = 0, retry = 0, over = 0, fresh = 0;
  liveLeads.forEach(L => {
    if (/DEAD|BAD/.test(L.status)) return;
    if (L.stage === 8 && L.stageStatus === 'Completed') return;
    if (sat && !L.sat) return;
    if (L.nextDate) {
      if (L.nextDate === tk) {
        if (/Ringing|Busy|Switched/.test(L.outcome || '')) retry++; else due++;
      } else if (L.nextDate < tk && L.status !== 'PARKED') {
        over++;
      }
    } else if ((L.stage ?? 0) === 0) {
      fresh++;
    }
  });
  return { dueToday: due + retry, overdue: over, freshDial: fresh };
}

// Returns the actual lead objects due today (due + retry), for the calling-script email.
// Same filtering rules as computeQueueCounts, just returns leads instead of a count.
function computeDueLeadsToday() {
  const allLeads = readJsonSafe('brl-leads', []);
  const liveLeads = allLeads.filter(l => l.src === 'import' || l.src === 'manual');
  const now = istNow();
  const tk = istDateKey(now);
  const sat = istIsSaturday(now);
  return liveLeads.filter(L => {
    if (/DEAD|BAD/.test(L.status)) return false;
    if (L.stage === 8 && L.stageStatus === 'Completed') return false;
    if (sat && !L.sat) return false;
    return L.nextDate === tk;
  });
}

function computeTodayStats() {
  const activity = readJsonSafe('brl-activity', []);
  const tk = istDateKey(istNow());
  const s = { dials: 0, conn: 0, em: 0, wa: 0, mtg: 0, rfq: 0 };
  activity.forEach(a => {
    const d = new Date(new Date(a.t).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    if (istDateKey(d) !== tk) return;
    if (a.ch === 'CALL') s.dials++;
    if (a.ch === 'EMAIL') s.em++;
    if (a.ch === 'WHATSAPP') s.wa++;
    if (a.ch === 'OUTCOME') {
      if (CONN_OUTCOMES.has(a.ty)) s.conn++;
      if (a.ty.indexOf('Meeting') > -1) s.mtg++;
      if (a.ty.indexOf('RFQ received') > -1) s.rfq++;
    }
  });
  return s;
}

async function sendWhatsAppTextServerSide(toDigits, message) {
  const settings = readJsonSafe('brl-settings', {});
  const to = '91' + toDigits;
  if (settings.waProvider === 'maytapi' && settings.maytapiProduct && settings.maytapiPhone && settings.maytapiKey) {
    const r = await fetchFn(`https://api.maytapi.com/api/${settings.maytapiProduct}/${settings.maytapiPhone}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-maytapi-key': settings.maytapiKey },
      body: JSON.stringify({ to_number: to, type: 'text', message }),
    });
    if (!r.ok) throw new Error('Maytapi send failed: ' + (await r.text()));
    return;
  }
  if (settings.waProvider === 'mas' && settings.masAuth) {
    const r = await fetchFn('https://app.messageautosender.com/api/v1/message/create', {
      method: 'POST',
      headers: { accept: 'application/json', Authorization: settings.masAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiverMobileNo: to, message: [message] }),
    });
    if (!r.ok) throw new Error('MAS send failed: ' + (await r.text()));
    return;
  }
  throw new Error('No WhatsApp provider configured — set "Send via" in Settings → WhatsApp.');
}

function dateStrIST(d) {
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
}

async function runMorningNotification(settings) {
  const ph = String(settings.notifyNumber || '').replace(/\D/g, '').slice(-10);
  if (!ph) return;
  const { dueToday, overdue, freshDial } = computeQueueCounts();
  const msg = `🌅 Morning Update — ${dateStrIST(istNow())}\n\n📞 Due Today: ${dueToday}\n⏰ Overdue: ${overdue}\n🆕 Fresh Dial: ${freshDial}\n\nOpen BRL Command Center to get started.`;
  await sendWhatsAppTextServerSide(ph, msg);
}

async function runEodNotification(settings) {
  const ph = String(settings.notifyNumber || '').replace(/\D/g, '').slice(-10);
  if (!ph) return;
  const t = computeTodayStats();
  const msg = `🌙 EOD Report — ${dateStrIST(istNow())}\n\n📞 Dials: ${t.dials}\n✅ Connected: ${t.conn}\n📧 Emails: ${t.em}\n💬 WhatsApp: ${t.wa}\n🤝 Meetings: ${t.mtg}\n📄 RFQs: ${t.rfq}\n\nEnd of day summary from BRL Command Center.`;
  await sendWhatsAppTextServerSide(ph, msg);
}

// ---- AI calling-script generation (Claude or Groq — user's choice, both via server) ---
const CALL_SCRIPT_STAGE_NAMES = ['Fresh — no connection yet', 'Intro Call Done', 'Meeting Fixed', 'Meeting Done', 'RFQ Received', 'Proposal Sent', 'Negotiation Initiated', 'Negotiation Done', 'Agreement Signed'];
const MAX_SCRIPTED_LEADS = 15; // cap per email — keeps cost/length/send-time reasonable

function callScriptPrompt(lead) {
  const stageName = CALL_SCRIPT_STAGE_NAMES[lead.stage ?? 0] || 'Unknown stage';
  return `You are helping a truck-freight (FTL logistics) sales rep at Best Roadways Limited prepare for a call today.

Lead: ${lead.co || 'Unknown company'}
Contact: ${lead.name || 'Unknown'}${lead.desig ? ' — ' + lead.desig : ''}
Industry: ${lead.industry || 'Not specified'}
Current funnel stage: ${stageName}
Last logged outcome: ${lead.outcome || 'None yet'}
Latest remarks: ${lead.remarks || 'None'}
Recent history: ${(lead.hist || '').slice(0, 500) || 'None'}

Write a short, practical calling script (6-10 lines max) for this specific call today. Tailor it to their industry and where they are in the sales funnel — e.g. an intro call sounds different from a negotiation follow-up. Keep it conversational, not robotic. No preamble, just the script.`;
}

async function generateCallScript(lead, settings) {
  const prompt = callScriptPrompt(lead);
  if (settings.aiProvider === 'groq' && settings.aiApiKey) {
    const r = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.aiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.aiModel || 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 400 }),
    });
    if (!r.ok) throw new Error('Groq API error: ' + (await r.text()));
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || '(no script generated)';
  }
  if (settings.aiProvider === 'claude' && settings.aiApiKey) {
    const r = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': settings.aiApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.aiModel || 'claude-3-5-haiku-20241022', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error('Claude API error: ' + (await r.text()));
    const j = await r.json();
    return j.content?.[0]?.text?.trim() || '(no script generated)';
  }
  throw new Error('No AI provider configured — set Claude or Groq API key in Settings → Due List Email.');
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildDueListEmailHtml(leads, scripts, truncated) {
  const rows = leads.map((L, i) => `
    <div style="border:1px solid #EBDFE0;border-radius:8px;padding:14px;margin-bottom:12px">
      <div style="font-weight:700;color:#A01220;font-size:15px">${escHtml(L.co || 'Unknown company')}</div>
      <div style="color:#6B5A5D;font-size:12.5px;margin-bottom:8px">${escHtml(L.name || '')}${L.desig ? ' — ' + escHtml(L.desig) : ''} · ${escHtml(L.industry || 'Industry not set')} · Stage ${L.stage ?? 0} (${escHtml(CALL_SCRIPT_STAGE_NAMES[L.stage ?? 0] || '')})</div>
      <div style="background:#FBF9F9;border-radius:6px;padding:10px 12px;font-size:13px;white-space:pre-wrap;color:#2A1518">${escHtml(scripts[i])}</div>
    </div>`).join('');
  return `
    <div style="font-family:Arial,sans-serif;max-width:640px">
      <h2 style="color:#A01220;margin-bottom:4px">Today's Due List — Calling Scripts</h2>
      <p style="color:#6B5A5D;font-size:13px;margin-top:0">${leads.length} lead(s) due today${truncated ? ` — showing the first ${MAX_SCRIPTED_LEADS}, see the app for the rest` : ''}.</p>
      ${rows}
      <p style="color:#999;font-size:11px;margin-top:20px">Generated automatically by BRL Command Center.</p>
    </div>`;
}

async function runDueListEmail(settings) {
  const toList = String(settings.dueListEmailTo || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!toList.length) throw new Error('No recipient set in Settings → Due List Email.');
  const transporter = buildTransporter(settings);
  if (!transporter) throw new Error('SMTP not configured — set it up in Settings → Email sending.');

  const dueLeads = computeDueLeadsToday();
  const truncated = dueLeads.length > MAX_SCRIPTED_LEADS;
  const scoped = dueLeads.slice(0, MAX_SCRIPTED_LEADS);
  const scripts = [];
  for (const lead of scoped) {
    try {
      scripts.push(await generateCallScript(lead, settings));
    } catch (e) {
      scripts.push('(Could not generate a script: ' + e.message + ')');
    }
  }
  const html = buildDueListEmailHtml(scoped, scripts, truncated);
  await transporter.sendMail({
    from: settings.smtpFrom || settings.smtpUser,
    to: toList.join(','),
    cc: (settings.dueListEmailCC !== undefined ? settings.dueListEmailCC : settings.suyashhEmail) || undefined,
    subject: `Today's Due List — Calling Scripts (${dateStrIST(istNow())})`,
    html,
  });
}

// Checked every minute. Uses a "last sent" date guard (stored back into
// brl-settings.json) so a match doesn't fire more than once per day even if
// this runs several times within the same minute or the server restarts.
cron.schedule('* * * * *', async () => {
  const settings = readJsonSafe('brl-settings', {});
  const now = istNow();
  const hhmm = now.toTimeString().slice(0, 5);
  const today = istDateKey(now);

  if (settings.notifyEnabled) {
    if (hhmm === (settings.morningTime || '09:00') && settings.lastMorningSent !== today) {
      try {
        await runMorningNotification(settings);
        settings.lastMorningSent = today;
        fs.writeFileSync(keyPath('brl-settings'), JSON.stringify(settings), 'utf8');
        console.log('Morning notification sent for', today);
      } catch (e) {
        console.error('Morning notification failed:', e.message);
      }
    }

    if (hhmm === (settings.eodTime || '18:00') && settings.lastEodSent !== today) {
      try {
        await runEodNotification(settings);
        settings.lastEodSent = today;
        fs.writeFileSync(keyPath('brl-settings'), JSON.stringify(settings), 'utf8');
        console.log('EOD notification sent for', today);
      } catch (e) {
        console.error('EOD notification failed:', e.message);
      }
    }
  }

  if (settings.dueListEmailEnabled && hhmm === (settings.dueListEmailTime || '08:30') && settings.lastDueListEmailSent !== today) {
    try {
      await runDueListEmail(settings);
      settings.lastDueListEmailSent = today;
      fs.writeFileSync(keyPath('brl-settings'), JSON.stringify(settings), 'utf8');
      console.log('Due-list email sent for', today);
    } catch (e) {
      console.error('Due-list email failed:', e.message);
    }
  }
}, { timezone: 'Asia/Kolkata' });

app.post('/api/send-due-list-email-test', async (req, res) => {
  const settings = readJsonSafe('brl-settings', {});
  try {
    await runDueListEmail(settings);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`BRL Command Center listening on http://127.0.0.1:${PORT}`);
});
