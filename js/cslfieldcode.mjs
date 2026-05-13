const moduleName = "cslcitation";
const FIELDCODE = 'CSL_CITATION';
const PREFIX = '';

import {
  CslData, DOI, PMID,
  retrieve_csl_for_doi, retrieve_csl_for_pmid, generate_csl_from_template,
  find_run_start, find_run_end, find_tables, parse_pmid, find_pmids,
  lookupIds,
} from './csl-utils.mjs';

const document_doi_cache = {};

// ── Module ───────────────────────────────────────────────────────────────────

const cslCitationModule = {
  name: 'CslCitationModule',
  prefix: PREFIX,

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

  // Sync: format the pre-resolved CSL data into a Mendeley CSL_CITATION field code.
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
    const csl_json = JSON.stringify(csl).replace(/&/g, '').replace(/[<>]/g, '');
    const addin_text = `ADDIN ${FIELDCODE} ${csl_json}`;

    const value =
      `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:instrText xml:space="preserve">${addin_text}</w:instrText></w:r>` +
      `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r w:rsidR="${codeid}" w:rsidRPr="${codeid}"><w:rPr><w:noProof/><w:highlight w:val="yellow"/></w:rPr>` +
      `<w:t>[REF ${citation_text}]</w:t></w:r>` +
      `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="end"/></w:r>`;

    return { value: value + errors.join('') };
  }
};

export default cslCitationModule;
