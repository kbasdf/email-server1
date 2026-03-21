// verify_dns.js
const fs = require('fs').promises;
const path = require('path');

const INPUT = 'final-results-dns.json';
const OUTPUT = 'final-results-dns-verified.json';

// Normalize domain: remove protocol, path, www, lowercase
function normalizeDomain(raw) {
  if (!raw) return '';
  let d = String(raw).trim();
  d = d.replace(/^https?:\/\//i, '');
  d = d.split(/[\/?#]/)[0];
  d = d.replace(/^www\./i, '');
  return d.toLowerCase();
}

// Simple registrable domain extractor with .co.in special-case
function registrableDomain(domain) {
  if (!domain) return '';
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  // handle .co.in special-case
  if (secondLast === 'co' && last === 'in') {
    if (parts.length >= 3) return parts.slice(-3).join('.');
    return parts.join('.');
  }
  // fallback: last two labels
  return parts.slice(-2).join('.');
}

// Parse DMARC string and extract rua/ruf mailto addresses
function parseDmarc(dmarcStr) {
  if (!dmarcStr || typeof dmarcStr !== 'string') return { rua: [], ruf: [] };
  const out = { rua: [], ruf: [] };
  const pairs = dmarcStr.split(';').map(s => s.trim()).filter(Boolean);
  for (const p of pairs) {
    const [k, ...rest] = p.split('=');
    if (!k || rest.length === 0) continue;
    const key = k.trim().toLowerCase();
    const val = rest.join('=').trim();
    if (key === 'rua' || key === 'ruf') {
      const addrs = val.split(',').map(s => s.trim()).filter(Boolean);
      for (const a of addrs) {
        const m = a.match(/mailto:([^?]+)/i);
        const addr = m ? m[1].trim() : a;
        const parts = addr.split('@');
        if (parts.length === 2) {
          const local = parts[0];
          const domain = normalizeDomain(parts[1]);
          if (key === 'rua') out.rua.push({ addr, local, domain });
          else out.ruf.push({ addr, local, domain });
        }
      }
    }
  }
  return out;
}

// Extract include: tokens from SPF-like TXT string
function extractSpfIncludes(txt) {
  if (!txt || typeof txt !== 'string') return [];
  const includes = [];
  const re = /include:([^\s;]+)/ig;
  let m;
  while ((m = re.exec(txt)) !== null) {
    if (m[1]) includes.push(normalizeDomain(m[1]));
  }
  return [...new Set(includes)].filter(Boolean);
}

// Extract domains from MX exchange hostnames (registrable)
function extractMxDomains(mxArray) {
  if (!Array.isArray(mxArray)) return [];
  const domains = [];
  for (const m of mxArray) {
    if (!m || !m.exchange) continue;
    const ex = normalizeDomain(m.exchange);
    const reg = registrableDomain(ex);
    if (reg) domains.push(reg);
  }
  return [...new Set(domains)].filter(Boolean);
}

// Add candidate with dedupe and simple confidence merging
function addCandidate(map, domain, source, confidence) {
  if (!domain) return;
  const d = normalizeDomain(domain);
  if (!d) return;
  const key = registrableDomain(d);
  if (!key) return;
  const existing = map.get(key);
  const rank = { high: 3, medium: 2, low: 1 };
  if (!existing) {
    map.set(key, { domain: key, sources: [source], confidence, score: baseScore(confidence) });
  } else {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (rank[confidence] > rank[existing.confidence]) existing.confidence = confidence;
    // update score conservatively: take max of base scores then add small bonus per unique source
    existing.score = Math.max(existing.score, baseScore(confidence));
    existing.score = Math.min(100, existing.score + Math.max(0, Math.min(5 * existing.sources.length, 20)));
  }
}

// Map confidence label to base numeric score
function baseScore(confidenceLabel) {
  switch ((confidenceLabel || '').toLowerCase()) {
    case 'high': return 90;
    case 'medium': return 60;
    case 'low': return 30;
    default: return 20;
  }
}

// Compute final numeric score (0-100) from candidate object
function finalizeScore(candidate) {
  // candidate.score already has base + source bonus; clamp to 100
  let s = Math.round(candidate.score || baseScore(candidate.confidence));
  if (s > 100) s = 100;
  if (s < 0) s = 0;
  return s;
}

async function main() {
  try {
    const raw = await fs.readFile(path.resolve(INPUT), 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error(`${INPUT} must be an array`);
    const out = [];

    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      const company = item.company || '';
      const domainRaw = item.domain || '';
      const domain = normalizeDomain(domainRaw);
      const dns = item.dns || {};
      const dmarcRaw = dns.dmarc || null;
      const txtRaw = dns.txt || null;
      const mxRaw = dns.mx || null;

      const candidates = new Map();

      // 1) include queried domain as low by default
      if (domain) addCandidate(candidates, domain, 'queried_domain', 'low');

      // 2) parse DMARC rua/ruf
      const parsed = parseDmarc(dmarcRaw);
      for (const r of parsed.rua) {
        const ruaReg = registrableDomain(r.domain);
        if (ruaReg && domain && (ruaReg === registrableDomain(domain) || r.domain === domain)) {
          addCandidate(candidates, domain, `dmarc.rua:${r.addr}`, 'high');
        } else {
          addCandidate(candidates, r.domain, `dmarc.rua:${r.addr}`, 'medium');
        }
      }
      for (const r of parsed.ruf) {
        const rufReg = registrableDomain(r.domain);
        if (rufReg && domain && (rufReg === registrableDomain(domain) || r.domain === domain)) {
          addCandidate(candidates, domain, `dmarc.ruf:${r.addr}`, 'high');
        } else {
          addCandidate(candidates, r.domain, `dmarc.ruf:${r.addr}`, 'medium');
        }
      }

      // 3) SPF includes
      const spfIncludes = extractSpfIncludes(txtRaw);
      for (const inc of spfIncludes) {
        if (domain && registrableDomain(inc) === registrableDomain(domain)) {
          addCandidate(candidates, domain, `spf.include:${inc}`, 'high');
        } else {
          addCandidate(candidates, inc, `spf.include:${inc}`, 'medium');
        }
      }

      // 4) MX hostnames
      const mxDomains = extractMxDomains(mxRaw);
      for (const mxdom of mxDomains) {
        if (domain && registrableDomain(mxdom) === registrableDomain(domain)) {
          addCandidate(candidates, domain, `mx:${mxdom}`, 'high');
        } else {
          addCandidate(candidates, mxdom, `mx:${mxdom}`, 'medium');
        }
      }

      // 5) Heuristic: DMARC local-part contains company token -> boost queried domain
      const companyToken = company ? company.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
      if (companyToken && parsed.rua.length > 0) {
        for (const r of parsed.rua) {
          const local = (r.local || '').toLowerCase();
          if (local.includes(companyToken) && domain) {
            addCandidate(candidates, domain, `dmarc.rua_local:${r.local}`, 'high');
          }
        }
      }

      // Build final array sorted by numeric score then domain
      const finalCandidates = Array.from(candidates.values())
        .map(c => {
          const score = finalizeScore(c);
          return { domain: c.domain, sources: c.sources, confidence: c.confidence, score };
        })
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.domain.localeCompare(b.domain);
        });

      out.push({
        company,
        domain,
        domains_possibilities: finalCandidates
      });
    }

    await fs.writeFile(path.resolve(OUTPUT), JSON.stringify(out, null, 2), 'utf8');
    console.log(`Wrote ${OUTPUT} (${out.length} entries)`);
  } catch (err) {
    console.error('Fatal:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

main();