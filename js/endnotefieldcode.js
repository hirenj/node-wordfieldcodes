const moduleName = "cslcitation";
const FIELDCODE = 'EN.CITE ';
const PREFIX = '';

class CslData {
  constructor(data) { this.data = data; }
}

function decodeEntities(encodedString) {
  return encodedString.replace(/&(nbsp|amp|quot|lt|gt);/g, (_, entity) => ({
    nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>'
  })[entity]).replace(/&#(\d+);/gi, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

const find_run_start = (elements, start_el) => {
  let previous = elements.slice(0, elements.indexOf(start_el)).reverse();
  let tag = previous.find(t => t.value && typeof t.value === 'string' && t.value.includes('w:fldCharType="begin"'));
  previous = previous.slice(previous.indexOf(tag));
  while (tag && tag.tag !== 'w:r' && previous.length > 0) tag = previous.shift();
  if (!tag || tag.tag !== 'w:r') throw new Error('Could not find run start');
  return tag;
};

const find_run_end = (elements, start_el) => {
  const nextels = elements.slice(elements.indexOf(start_el));
  const tag = nextels.find(t => t.value && typeof t.value === 'string' && t.value.includes('w:fldCharType="end"'));
  return nextels[nextels.indexOf(tag) + 1];
};

const find_tables = (postparsed) => {
  const table_starts = postparsed.filter(bit => bit.type === 'content' && bit.value.includes('<w:tbl>'));
  return table_starts.map(start => {
    const start_idx = postparsed.indexOf(start);
    const end = postparsed.slice(start_idx).find(bit => bit.type === 'content' && bit.value.includes('</w:tbl>'));
    const table = postparsed.slice(start_idx, postparsed.indexOf(end) + 1);
    const boundaries = table.filter(bit => ['w:tc', 'w:tr'].includes(bit.tag) && bit.position === 'start').map(bit => bit.tag);
    const num_columns = boundaries.slice(1).indexOf('w:tr');
    const cellstarts = table.filter(bit => bit.tag === 'w:tc' && bit.position === 'start');
    const headers = [], cells = [];
    cellstarts.forEach((start_cell, idx) => {
      const si = table.indexOf(start_cell);
      const end_cell = table.slice(si).find(bit => bit.tag === 'w:tc' && bit.position === 'end');
      const cell = postparsed.slice(postparsed.indexOf(table[si]), postparsed.indexOf(end_cell) + 1);
      const content = cell.filter(bit => bit.position === 'insidetag').map(bit => bit.value).join('');
      const row_num = Math.floor(idx / num_columns);
      if (row_num === 0) { headers.push(content.toLowerCase()); }
      else {
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
  if (a_pmid) return { key: pmid.replace(/PMID:.*/, ''), pmidval: a_pmid };
};

const find_pmids = (placeholders) => {
  const all_pmids = [].concat(...placeholders
    .filter(bit => bit.value.match(/PMID/))
    .map(bit => bit.value.split(',').map(v => v.trim())));
  return all_pmids.flatMap(pmid => {
    const parsed = parse_pmid(pmid);
    return parsed ? [{ reference: parsed.key.trim(), pmid: parsed.pmidval }] : [];
  });
};

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
      const whole_value = postparsed
        .slice(postparsed.indexOf(field_start), postparsed.indexOf(field_end))
        .filter(item => item.tag !== 'w:r')
        .map(item => item.value)
        .join('')
        .replace(/xml:space="preserve"/g, '');

      // Try base64-encoded field data first, fall back to instrText.
      let endnote_instruction;
      const base64_re = /<w:fldData[^>]*>(([^<]|\n)*?)<\/w:fldData>/g;
      let match;
      const base64_texts = [];
      while ((match = base64_re.exec(whole_value)) !== null) base64_texts.push(match[1]);
      for (const b64 of base64_texts.reverse()) {
        endnote_instruction = (endnote_instruction || '') + Buffer.from(b64, 'base64').toString('ascii');
      }

      const instr_text_re = /<w:instrText[^>]*>(([^<]|\n)*?)<\/w:instrText>/g;
      let instr_texts = '';
      while ((match = instr_text_re.exec(whole_value)) !== null) instr_texts += match[1];

      const xml_parts = instr_texts.match(/ADDIN EN.CITE\s*([^}]+)/);
      if (!xml_parts) continue;
      if (xml_parts[1].includes('.DATA')) continue;
      if (!endnote_instruction) endnote_instruction = decodeEntities(xml_parts[1]);
      if (!endnote_instruction) continue;

      const pubmeds = [];
      for (const cite_text of endnote_instruction.split(/<Cite>/).filter(v => v.trim())) {
        let PMID, title;
        if ((match = /(?:pubmed\/|accession-num>)(\d+)/.exec(cite_text)) !== null) PMID = match[1];
        if ((match = /<Author>([^<]+)<\/Author><Year>([^<]+)<\/Year>/.exec(cite_text)) !== null) title = match[1] + match[2];
        if (PMID && !pubmeds.find(p => p.PMID === PMID)) pubmeds.push({ PMID, title });
      }
      if (pubmeds.length < 1) console.log('No PMIDs found in EndNote field:', whole_value);

      postparsed.splice(
        postparsed.indexOf(field_start),
        postparsed.indexOf(field_end) - postparsed.indexOf(field_start) + 1,
        { value: new CslData(pubmeds), type: 'placeholder', module: moduleName }
      );
    }
    return { postparsed, errors: [] };
  },

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

  // No async work needed — the data was already extracted in postparse.
  resolve(part, options) {
    if (part.module !== moduleName) return null;
    return Promise.resolve(part.value);
  },

  render(part, options) {
    if (part.module !== moduleName) return null;

    const resolvedItem = (options.resolved || []).find(r => r.lIndex === part.lIndex);
    const data = resolvedItem ? resolvedItem.value : null;

    const pubmeds = data instanceof CslData ? data.data : null;
    if (!pubmeds || pubmeds.length < 1) {
      return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r>` };
    }

    const pubmed_string = pubmeds.map(({ PMID, title }) => `${title || 'Unknown'} PMID:${PMID}`).join(',');
    return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="green"/></w:rPr><w:t>[REF ${pubmed_string}]</w:t></w:r>` };
  }
};

module.exports = cslCitationModule;
