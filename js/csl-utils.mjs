import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// Optional SQLite-backed PMID/DOI mapping — not available in browser environments.
let lookupIds = null;
try { lookupIds = require('./lookup_ids.js'); } catch(e) {}

// Persistent DOI metadata cache (keyed by DOI string).
let cached_results_doi = {};
const CACHE_FILE = process.cwd() + '/cached_data.json';
try { cached_results_doi = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}

process.on('exit', () => {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cached_results_doi), 'utf8'); } catch(e) {}
});
process.on('SIGINT', () => process.exit(2));

export class CslData {
  constructor(data) { this.data = data; }
}

export class DOI {
  constructor(value, identifier) { this.value = value; this.identifier = identifier; }
}

export class PMID {
  constructor(value, identifier) { this.value = value; this.identifier = identifier; }
}

const just_seen_error = {};

export const retrieve_csl_for_doi = async (doi) => {
  if (!just_seen_error[doi] && cached_results_doi[doi] && cached_results_doi[doi].error) {
    delete cached_results_doi[doi];
  }
  let crossref_data;
  try {
    if (cached_results_doi[doi]) {
      crossref_data = cached_results_doi[doi];
    } else {
      console.log(`Fetching fresh CSL for ${doi}`);
      const clean_doi = doi.replace('https://doi.org/', '');
      crossref_data = await fetch(`https://dx.doi.org/${clean_doi}`, {
        headers: { 'Accept': 'application/citeproc+json' }
      }).then(res => res.json());
    }
  } catch (err) {
    if (err.type === 'invalid-json') {
      crossref_data = { DOI: doi, error: true };
    } else {
      throw err;
    }
  }
  delete crossref_data.license;
  delete crossref_data.reference;
  if ((crossref_data.type || '').indexOf('article') >= 0) {
    crossref_data.type = 'article-journal';
  }
  cached_results_doi[doi] = crossref_data;
  if (!crossref_data.type) just_seen_error[doi] = true;
  return crossref_data;
};

const cached_results_pmid = {};

export const sleep_wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetch_pmid_doi_data = async (pmid, tries = 1) => {
  let pmid_data = cached_results_pmid[pmid]
    || await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`)
         .then(res => res.json());
  if (!pmid_data || !('result' in pmid_data) || !(pmid in pmid_data.result)) {
    if (tries > 0) {
      await sleep_wait(500);
      return fetch_pmid_doi_data(pmid, tries - 1);
    }
    console.log(`Failed to retrieve data from eutils for PMID ${pmid}`);
    return;
  }
  if (pmid_data.result[pmid]) cached_results_pmid[pmid] = pmid_data;
  return pmid_data.result[pmid].articleids.filter(a => a.idtype === 'doi').map(a => a.value)[0];
};

export const retrieve_csl_for_pmid = async (pmid, tries = 2) => {
  let doi = lookupIds ? lookupIds.search_by_pmid(pmid) : null;
  if (!doi) {
    console.log(`Retrieving CSL for PMID ${pmid}`);
    doi = await fetch_pmid_doi_data(pmid, tries);
    doi = typeof doi === 'string' ? doi : doi?.DOI;
  } else {
    console.log(`Using library DOI for PMID ${pmid}`);
    doi = doi.DOI;
  }
  if (!doi) return;
  console.log(`PMID ${pmid} → ${doi}`);
  if (!doi.startsWith('http')) doi = `https://doi.org/${doi}`;

  let csl = await retrieve_csl_for_doi(doi);
  if (!('authors' in csl)) delete csl.DOI;
  csl.PMID = pmid;
  return csl;
};

const get_entry_obj = (key, id) => {
  if (key.startsWith('DOI:')) return new DOI(key.replace('DOI:', '').trim(), id);
  if (key.startsWith('PMID:')) return new PMID(key.replace('PMID:', '').trim(), id);
};

export const generate_csl_from_template = async (values) => {
  const all_ids = [];
  for (const { id, lookup } of values) {
    if (lookup) {
      all_ids.push(get_entry_obj(lookup, id));
      continue;
    }
    let re = /PMID\s*[:_]?[_\s]*(\d+)/gi;
    let m;
    while ((m = re.exec(id))) all_ids.push(new PMID(m[1], `PMID:${m[1]}`));
    re = /DOI\s*[:_]?[_\s]*(10\.\d{4,9}\/[-._;()\/:A-Z0-9]+)/gi;
    while ((m = re.exec(id))) all_ids.push(new DOI(m[1], `DOI:${m[1]}`));
    // Bare numbers (e.g. [REF 1234567, 5678910]) are assumed to be PMIDs.
    // Strip leading underscores that result from space→_ substitution in ids.
    const bare = id.replace(/^[_\s]+|[_\s]+$/g, '');
    if (bare && /^\d+$/.test(bare)) all_ids.push(new PMID(bare, `PMID:${bare}`));
  }

  let citationItems = await Promise.all(
    all_ids.filter(Boolean).map(async (reference) => {
      const part_id = reference.identifier.replace(/[\s:]+/g, '_').toLowerCase();
      const ref_csl = {
        ID: 'NICKNAME' + part_id,
        author: [{ 'dropping-particle': '', family: part_id, given: '',
                   'non-dropping-particle': '', 'parse-names': false, suffix: '' }]
      };
      let csl = ref_csl;
      if (reference instanceof DOI) {
        csl = await retrieve_csl_for_doi(reference.value);
        csl.ID = 'NICKNAME' + part_id;
      }
      if (reference instanceof PMID) {
        csl = await retrieve_csl_for_pmid(reference.value);
        let tries = 3;
        while (!csl) {
          if (tries-- === 0) { csl = ref_csl; break; }
          await sleep_wait(500);
          csl = await retrieve_csl_for_pmid(reference.value);
        }
        csl.PMID = reference.value;
        csl.ID = 'NICKNAME' + part_id;
      }
      if (csl.DOI?.startsWith('10.1101') && !csl.journalAbbreviation) {
        csl.journalAbbreviation = 'bioRxiv';
      }
      return {
        id: 'NICKNAME' + part_id,
        itemData: csl,
        uris: [`http://www.mendeley.com/documents/?uuid=${part_id}`]
      };
    })
  );
  citationItems = citationItems.filter(Boolean);

  const formatted = all_ids.map(ref => ref.identifier).join(',');
  return {
    citationItems,
    mendeley: {
      formattedCitation: `[REF ${formatted}]`,
      plainTextFormattedCitation: `[REF ${formatted}]`
    },
    properties: { noteIndex: 0 },
    schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json'
  };
};

// ── docxtemplater XML helpers ────────────────────────────────────────────────

export const find_run_start = (elements, start_el) => {
  let previous = elements.slice(0, elements.indexOf(start_el)).reverse();
  let tag = previous.find(t => t.value && typeof t.value === 'string' && t.value.includes('w:fldCharType="begin"'));
  previous = previous.slice(previous.indexOf(tag));
  while (tag.tag !== 'w:r' && previous.length > 0) tag = previous.shift();
  if (tag.tag !== 'w:r') throw new Error('Could not find run start for element');
  return tag;
};

export const find_run_end = (elements, start_el) => {
  const nextels = elements.slice(elements.indexOf(start_el));
  const tag = nextels.find(t => t.value && typeof t.value === 'string' && t.value.includes('w:fldCharType="end"'));
  return nextels[nextels.indexOf(tag) + 1];
};

export const find_tables = (postparsed) => {
  const table_starts = postparsed.filter(bit => bit.type === 'content' && bit.value.includes('<w:tbl>'));
  const table_indices = table_starts.map(start => {
    const start_idx = postparsed.indexOf(start);
    const end = postparsed.slice(start_idx).find(bit => bit.type === 'content' && bit.value.includes('</w:tbl>'));
    return { start: start_idx, end: postparsed.indexOf(end) + 1 };
  });

  return table_indices.map(({ start, end }) => {
    const table = postparsed.slice(start, end);
    const boundaries = table.filter(bit => ['w:tc', 'w:tr'].includes(bit.tag) && bit.position === 'start').map(bit => bit.tag);
    const num_columns = boundaries.slice(1).indexOf('w:tr');
    const cellstarts = table.filter(bit => bit.tag === 'w:tc' && bit.position === 'start');
    const cell_indices = cellstarts.map(start_cell => {
      const si = table.indexOf(start_cell);
      const end_cell = table.slice(si).find(bit => bit.tag === 'w:tc' && bit.position === 'end');
      return { start: postparsed.indexOf(table[si]), end: postparsed.indexOf(end_cell) + 1 };
    });
    const headers = [];
    const cells = [];
    cell_indices.forEach(({ start: cs, end: ce }, idx) => {
      const cell = postparsed.slice(cs, ce);
      const content = cell.filter(bit => bit.position === 'insidetag').map(bit => bit.value).join('');
      const row_num = Math.floor(idx / num_columns);
      if (row_num === 0) {
        headers.push(content.toLowerCase());
      } else {
        if (!cells[row_num - 1]) cells[row_num - 1] = {};
        cells[row_num - 1][headers[idx % num_columns]] = content;
      }
    });
    return cells;
  });
};

export const parse_pmid = (pmid) => {
  const re = /PMID[:_][_\s]*(\d+)/gi;
  let m, a_pmid;
  while ((m = re.exec(pmid))) a_pmid = m[1];
  if (a_pmid) return { key: pmid.replace(/PMID\:.*/, ''), pmidval: a_pmid };
};

export const find_pmids = (placeholders) => {
  const all_pmids = [].concat(...placeholders
    .filter(bit => bit.value.match(/PMID/))
    .map(bit => bit.value.split(',').map(v => v.trim())));
  const results = [];
  for (const pmid of all_pmids) {
    const parsed = parse_pmid(pmid);
    if (parsed) results.push({ reference: parsed.key.trim(), pmid: parsed.pmidval });
  }
  return results;
};

export { lookupIds };
