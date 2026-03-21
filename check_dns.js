// check-dns.js (integrated normalizer + DNS checks)
const fs = require('fs').promises;
const { Resolver } = require('dns');

const resolver = new Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1']);

const INPUT_PATH = 'final-results.json';
const NORMALIZED_PATH = 'final-results-normalized.json';
const OUTPUT_PATH = 'final-results-dns.json';

function normalizeDomain(raw){
  if (!raw) return '';
  let d = String(raw).trim();
  d = d.replace(/^https?:\/\//i, '');
  d = d.split(/[\/?#]/)[0];
  d = d.replace(/^www\./i, '');
  return d.toLowerCase();
}

async function normalizeAndWrite(){
  // read original file
  const raw = await fs.readFile(INPUT_PATH, 'utf8');
  const arr = JSON.parse(raw);
  const seen = new Set();
  const out = [];
  for (const item of arr){
    const company = (item.company || '').trim();
    const domain = normalizeDomain(item.domain || '');
    const key = `${company}||${domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ company, domain });
  }
  await fs.writeFile(NORMALIZED_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Normalized ${arr.length} entries -> ${out.length} unique entries written to ${NORMALIZED_PATH}`);
  return out;
}

// DNS helper functions (unchanged)
function joinTxtRecords(txtArr){
  if (!Array.isArray(txtArr)) return null;
  return txtArr.map(parts => Array.isArray(parts) ? parts.join('') : String(parts)).join(' | ');
}

function resolveWithTimeout(fn, arg, ms = 8000){
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ error: 'timeout' }); }
    }, ms);
    fn(arg, (err, res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) return resolve({ error: err.code || err.message || String(err) });
      return resolve(res);
    });
  });
}

async function checkDns(domain){
  const d = normalizeDomain(domain);
  if (!d) return { error: 'empty_domain' };

  // MX
  const mxRes = await resolveWithTimeout(resolver.resolveMx.bind(resolver), d);
  let mx = null;
  if (mxRes && mxRes.error) mx = { error: mxRes.error };
  else if (Array.isArray(mxRes)) mx = mxRes.map(m => ({ exchange: m.exchange, priority: m.priority }));

  // A fallback
  let a = null;
  if (!mx || (mx && mx.error)) {
    const aRes = await resolveWithTimeout(resolver.resolve4.bind(resolver), d);
    if (aRes && aRes.error) a = { error: aRes.error };
    else if (Array.isArray(aRes)) a = aRes.slice();
  }

  // TXT
  const txtRes = await resolveWithTimeout(resolver.resolveTxt.bind(resolver), d);
  let txt = null;
  if (txtRes && txtRes.error) txt = { error: txtRes.error };
  else if (Array.isArray(txtRes)) txt = joinTxtRecords(txtRes);

  // DMARC
  const dmarcRes = await resolveWithTimeout(resolver.resolveTxt.bind(resolver), '_dmarc.' + d);
  let dmarc = null;
  if (dmarcRes && dmarcRes.error) dmarc = { error: dmarcRes.error };
  else if (Array.isArray(dmarcRes)) dmarc = joinTxtRecords(dmarcRes);

  return { mx, a, txt, dmarc };
}

async function runAll(){
  // 1) normalize and get list (ensures normalization completes before DNS)
  const normalizedList = await normalizeAndWrite();

  // 2) run DNS checks on normalizedList
  const out = [];
  for (let i = 0; i < normalizedList.length; i++){
    const { company, domain } = normalizedList[i];
    const normalized = normalizeDomain(domain);
    process.stdout.write(`(${i+1}/${normalizedList.length}) ${company} -> ${normalized || '(empty)'} ... `);
    if (!normalized) {
      console.log('no domain');
      out.push({ company, domain: '', dns: null, note: 'no domain provided' });
      continue;
    }
    try {
      const dnsInfo = await checkDns(normalized);
      console.log('done');
      out.push({ company, domain: normalized, dns: dnsInfo });
    } catch (err) {
      console.log('error');
      out.push({ company, domain: normalized, dns: null, error: String(err) });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', OUTPUT_PATH);
}

runAll().catch(e => { console.error('Fatal', e); process.exit(1); });