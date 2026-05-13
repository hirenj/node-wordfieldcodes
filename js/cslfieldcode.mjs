const moduleName = "cslcitation";
const FIELDCODE = 'CSL_CITATION';
const PREFIX = '';

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

class CslData {
  constructor(data) { this.data = data; }
}

class DOI {
  constructor(value, identifier) { this.value = value; this.identifier = identifier; }
}

class PMID {
  constructor(value, identifier) { this.value = value; this.identifier = identifier; }
}

const just_seen_error = {};

const retrieve_csl_for_doi = async (doi) => {
  if (!just_seen_error[doi] && cached_results_doi[doi] && cached_results_doi[doi].error) {
    delete cached_results_doi[doi];
  }
  let crossref_data;
  try {
    if (cached_results_doi[doi]) {
      crossref_data = cached_results_doi[doi];
    } else {
      console.log(`Fetching fresh CSL for ${doi}`);
      let clean_doi = doi.replace('https://doi.org/', '');
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

const sleep_wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

const retrieve_csl_for_pmid = async (pmid, tries = 2) => {
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

const generate_csl_from_template = async (values) => {
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

const find_run_start = (elements, start_el) => {
  let previous = elements.slice(0, elements.indexOf(start_el)).reverse();
  let tag = previous.find(t => t.value && typeof t.value === 'string' && t.value.includes('w:fldCharType="begin"'));
  previous = previous.slice(previous.indexOf(tag));
  while (tag.tag !== 'w:r' && previous.length > 0) tag = previous.shift();
  if (tag.tag !== 'w:r') throw new Error('Could not find run start for element');
  return tag;
};

const find_run_end = (elements, start_el) => {
  const nextels = elements.slice(elements.indexOf(start_el));
  const tag = nextels.find(t => t.value && typeof t.value === 'string' && t.value.includes('w:fldCharType="end"'));
  return nextels[nextels.indexOf(tag) + 1];
};

const find_tables = (postparsed) => {
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

const parse_pmid = (pmid) => {
  const re = /PMID[:_][_\s]*(\d+)/gi;
  let m, a_pmid;
  while ((m = re.exec(pmid))) a_pmid = m[1];
  if (a_pmid) return { key: pmid.replace(/PMID\:.*/, ''), pmidval: a_pmid };
};

const find_pmids = (placeholders) => {
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

const document_doi_cache = {};

let recordnumber = 100000;

// ── Module ───────────────────────────────────────────────────────────────────

const cslCitationModule = {
  name: 'CslCitationModule',
  prefix: PREFIX,
  writer: 'csl',

  parse(placeHolderContent) {
    return { type: 'placeholder', value: placeHolderContent.trim(), module: moduleName };
  },

  postparse(postparsed, options) {
    this.tables = find_tables(postparsed);

    const placeholders = postparsed.filter(bit => bit.type === 'placeholder' && bit.module === moduleName);
    this.tables = this.tables.concat([find_pmids(placeholders)]);

    for (const placeholder of placeholders) {
      postparsed.splice(postparsed.indexOf(placeholder), 0,
        { type: 'tag', position: 'end', text: true,  value: '</w:t>', tag: 'w:t' },
        { type: 'tag', position: 'end', text: false, value: '</w:r>', tag: 'w:r' }
      );
      postparsed.splice(postparsed.indexOf(placeholder) + 1, 0,
        { type: 'tag', position: 'start', text: false, value: '<w:r>', tag: 'w:r' },
        { type: 'tag', position: 'start', text: true,  value: '<w:t>', tag: 'w:t' }
      );
    }

    const fieldcodes = postparsed.filter(bit => bit.type === 'content' && bit.value.includes(FIELDCODE));
    for (const field of fieldcodes) {
      if (field.removed) continue;
      const field_start = find_run_start(postparsed, field);
      const field_end   = find_run_end(postparsed, field);
      let whole_value = postparsed
        .slice(postparsed.indexOf(field_start), postparsed.indexOf(field_end))
        .filter(item => item.tag !== 'w:r')
        .map(item => item.value)
        .join('')
        .replace(/xml:space="preserve"/g, '');

      const instr_text_re = /<w:instrText[^>]*>(([^<]|\n)*?)<\/w:instrText>/g;
      let match, instr_texts = '';
      while ((match = instr_text_re.exec(whole_value)) !== null) instr_texts += match[1];
      if (!instr_texts) continue;

      const json_part = instr_texts.match(/ADDIN (?:ZOTERO_ITEM )?CSL_CITATION\s*([^<]+)/);
      if (!json_part) continue;

      let csl;
      try {
        csl = new CslData(JSON.parse(json_part[1]));
      } catch (err) {
        console.log(instr_texts, json_part[1]);
        throw err;
      }

      csl.data.citationItems = csl.data.citationItems.map(item => {
        if (!item.itemData.note) return item;
        if ((item.itemData.note.includes('PMID') && !item.itemData.PMID) ||
            (item.itemData.note.includes('DOI')  && !item.itemData.DOI)) {
          const note_info = item.itemData.note.match(/((?:DOI|PMID)):\s*(\S*)/);
          if (note_info) item.itemData[note_info[1]] = note_info[2];
        }
        return item;
      });

      csl.data.citationItems = csl.data.citationItems.map(item => {
        if (item.itemData.DOI) {
          if (!document_doi_cache[item.itemData.DOI]) {
            document_doi_cache[item.itemData.DOI] = item;
          }
          return document_doi_cache[item.itemData.DOI];
        }
        return item;
      });

      postparsed.splice(
        postparsed.indexOf(field_start),
        postparsed.indexOf(field_end) - postparsed.indexOf(field_start) + 1,
        { value: csl, type: 'placeholder', module: moduleName }
      );
    }
    return { postparsed, errors: [] };
  },

  // Push table-derived scope entries before async resolution begins.
  preResolve(options) {
    if (!this.tables) return;
    for (const table of this.tables.filter(t => t.length > 0)) {
      if (table[0].reference && (table[0].doi || table[0].pmid)) {
        options.scopeManager.scopeList.push(
          table.reduce((acc, row) => {
            acc[row.reference.toLowerCase()] = row.pmid ? `PMID:${row.pmid}` : `DOI:${row.doi}`;
            return acc;
          }, {})
        );
      }
    }
  },

  // Async: fetch all citation data. The result is stored by docxtemplater
  // and passed to render() via options.resolved, keyed by part.lIndex.
  async resolve(part, options) {
    if (part.module !== moduleName) return null;

    if (part.value instanceof CslData) {
      const csl = JSON.parse(JSON.stringify(part.value.data));
      csl.citationItems = await Promise.all(csl.citationItems.map(async (item) => {
        if (item.id && String(item.id).match(/^NICKNAME/)) {
          const id = String(item.id).replace(/^NICKNAME/, '');
          const lookup = options.scopeManager.getValue(id, { part });
          const resolved = await generate_csl_from_template([{ id, lookup }]);
          return resolved ? resolved.citationItems[0] : item;
        }
        return item;
      }));
      return csl;
    }

    const all_ids = part.value.split(',').map(id => id.replace(/\s+/g, '_').toLowerCase());
    const values = all_ids.map(id => ({
      id,
      lookup: options.scopeManager.getValue(id, { part })
    }));
    return generate_csl_from_template(values);
  },

  // Sync: format the pre-resolved CSL data into Word XML.
  render(part, options) {
    if (part.module !== moduleName) return null;

    const resolvedItem = (options.resolved || []).find(r => r.lIndex === part.lIndex);
    const csl = resolvedItem ? resolvedItem.value : null;

    if (!csl || csl.citationItems.length < 1) {
      console.log('Missing CSL for', part.value);
      return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r>` };
    }

    const errors = [];
    for (const cslitem of csl.citationItems) {
      if (lookupIds && !cslitem.itemData.PMID && cslitem.itemData.DOI) {
        const found = lookupIds.search_by_doi(cslitem.itemData.DOI);
        if (found) cslitem.itemData.PMID = found.PMID;
      }
      if (!cslitem.itemData.type) {
        const tag = cslitem.itemData.PMID
          ? `PMID:${cslitem.itemData.PMID}` : `DOI:${cslitem.itemData.DOI}`;
        errors.push(`<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${tag}]</w:t></w:r>`);
      }
    }
    csl.citationItems = csl.citationItems.filter(item => item.itemData.type);

    let citation_text = csl.citationItems
      .map(item => ({ pm: item.itemData.PMID, doi: item.itemData.DOI }))
      .filter(({ pm, doi }) => pm || doi)
      .map(({ pm, doi }) => pm ? `PMID:${pm}` : `DOI:${doi}`)
      .join(', ');

    const super_sub = citation_text.match(/&lt;su[pb]&gt;(.*)&lt;\/su[pb]&gt;/);
    if (super_sub) citation_text = super_sub[1];

    const codeid = FIELDCODE + Date.now();
    let addin_text;

    if (this.writer === 'csl') {
      const csl_json = JSON.stringify(csl).replace(/&/g, '').replace(/[<>]/g, '');
      addin_text = `ADDIN ${FIELDCODE} ${csl_json}`;
    }

    if (this.writer === 'endnote') {
      let endnote_xml = '<EndNote>' + csl.citationItems.map(item => {
        if (!item.recordnumber) { item.recordnumber = recordnumber++; }
        const doi_text  = item.itemData.DOI
          ? `<electronic-resource-num>${item.itemData.DOI}</electronic-resource-num>`.replace(/&[lg]t;/g, '')
          : '';
        const pmid_text = item.itemData.PMID
          ? `<accession-num>${item.itemData.PMID}</accession-num>
<urls><related-urls><url>https://www.ncbi.nlm.nih.gov/pubmed/${item.itemData.PMID}</url></related-urls></urls>
<remote-database-name>Medline</remote-database-name>
<remote-database-provider>NLM</remote-database-provider>`
          : '';
        const year = item.itemData.issued?.['date-parts']?.[0]?.[0] ?? '2025';
        return `<Cite>
<Author>${item.itemData.author[0].family}</Author>
<Year>${year}</Year>
<DisplayText>${item.itemData.PMID || item.itemData.DOI}</DisplayText>
<record>
  <ref-type name="Journal Article">17</ref-type>
  <foreign-keys><key app="EN" db-id="blag">${item.recordnumber}</key></foreign-keys>
  <rec-number>${item.recordnumber}</rec-number>
  <titles><title>${item.itemData.title}</title></titles>
  <dates><year>${year}</year></dates>
  ${pmid_text}
  ${doi_text}
</record>
</Cite>`;
      }).join('') + '</EndNote>';
      endnote_xml = endnote_xml.replace(/&[lg]t;/g, '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      addin_text = ` ADDIN EN.CITE ${endnote_xml}`;
    }

    let value;
    if (addin_text) {
      value = `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>` +
              `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:instrText xml:space="preserve">${addin_text}</w:instrText></w:r>` +
              `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>` +
              `<w:r w:rsidR="${codeid}" w:rsidRPr="${codeid}"><w:rPr><w:noProof/><w:highlight w:val="yellow"/></w:rPr>` +
              `<w:t>[REF ${citation_text}]</w:t></w:r>` +
              `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="end"/></w:r>`;
    } else {
      value = `<w:r><w:rPr><w:noProof/><w:highlight w:val="yellow"/></w:rPr><w:t>[REF ${citation_text}]</w:t></w:r>`;
    }

    return { value: value + errors.join('') };
  }
};

export default cslCitationModule;
