// resolve_domains.js
const fs = require('fs').promises;
const cheerio = require('cheerio');
const { stringify } = require('csv-stringify/sync');

const INPUT = 'companies.txt'; // one company per line
const OUT_CSV = 'results.csv';
const OUT_JSON = 'results1.json';
const DELAY_MS = 1200; // polite delay between searches

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function extractDomain(url){
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./,'');
  } catch(e){
    return null;
  }
}

async function duckSearchFirstUrl(query){
  // DuckDuckGo HTML search (no JS)
  const q = encodeURIComponent(query + ' india website');
  const url = `https://html.duckduckgo.com/html/?q=${q}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  const $ = cheerio.load(text);
  // DuckDuckGo HTML returns results in .result__a anchors
  const a = $('.result__a').first();
  if (!a || !a.attr('href')) return null;
  // href may be a redirect; try to extract actual URL
  const href = a.attr('href');
  // If href is a direct URL, return it; otherwise try to parse query param 'uddg'
  if (href.startsWith('http')) return href;
  const m = href.match(/uddg=(.+)$/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch(e) { return href; }
  }
  return href;
}

async function main(){
  const raw = await fs.readFile(INPUT, 'utf8');
  const companies = raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const results = [];

for (let i = 0; i < companies.length; i++) {
  const name = companies[i];
  console.log(`[${i + 1}/${companies.length}] Searching: ${name}`);
  try {
    const url = await duckSearchFirstUrl(name);
    await sleep(DELAY_MS);
    const domain = url ? extractDomain(url) : null;
    const tld = domain ? domain.split('.').slice(-2).join('.') : null; // e.g., wipro.com or wipro.co.in -> last two parts

    // topLevel: prefer .co.in, then .in, otherwise last label (e.g., .com, .org)
    const topLevel = domain
      ? (domain.endsWith('.co.in')
          ? '.co.in'
          : (domain.endsWith('.in') ? '.in' : '.' + domain.split('.').pop()))
      : null;

    results.push({
      company: name,
      url: url || '',
      domain: domain || '',
      topLevel: topLevel || '',
      confidence: domain ? 'high' : 'low'
    });
  } catch (err) {
    console.error('Error for', name, err.message || err);
    results.push({ company: name, url: '', domain: '', topLevel: '', confidence: 'error' });
  }
}

  // write CSV
  const csv = stringify(results, { header: true, columns: ['company','domain','topLevel','url','confidence'] });
  await fs.writeFile(OUT_CSV, csv, 'utf8');
  await fs.writeFile(OUT_JSON, JSON.stringify(results, null, 2), 'utf8');
  console.log('Done. Results written to', OUT_CSV, OUT_JSON);
}

main().catch(e=>{ console.error(e); process.exit(1); });