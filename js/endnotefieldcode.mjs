const moduleName = 'endnotecitation';
const EN_FIELDCODE = 'EN.CITE ';
const CSL_FIELDCODE = 'CSL_CITATION';
const PREFIX = '';

import {
  CslData,
  find_run_start, find_run_end, find_tables, parse_pmid, find_pmids,
  generate_csl_from_template,
} from './csl-utils.mjs';

function decodeEntities(encodedString) {
  return encodedString
    .replace(/&(nbsp|amp|quot|lt|gt);/g, (_, entity) => ({
      nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>'
    })[entity])
    .replace(/&#(\d+);/gi, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

// ── Read mode: EN.CITE → [REF PMID:xxx] ─────────────────────────────────────

function postparse_read(postparsed) {
  const placeholders = postparsed.filter(bit => bit.type === 'placeholder' && bit.module === moduleName);

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

  const fieldcodes = postparsed.filter(bit => bit.type === 'content' && bit.value.includes(EN_FIELDCODE));
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
}

function render_read(data, part) {
  const pubmeds = data instanceof CslData ? data.data : null;
  if (!pubmeds || pubmeds.length < 1) {
    return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r>` };
  }
  const pubmed_string = pubmeds.map(({ PMID, title }) => `${title || 'Unknown'} PMID:${PMID}`).join(',');
  return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="green"/></w:rPr><w:t>[REF ${pubmed_string}]</w:t></w:r>` };
}

// ── Write mode: CSL_CITATION → EN.CITE ──────────────────────────────────────

// Strip HTML markup, normalise common Unicode typography to ASCII, then drop
// any remaining non-ASCII bytes.  EndNote's instrText parser is fragile with
// multi-byte UTF-8 sequences (α, –, curly quotes, etc. all break it).
const sanitize = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/<[^>]*>/g, '')              // strip HTML tags
  .replace(/[‘’]/g, "'")      // curly single quotes → '
  .replace(/[“”]/g, '"')      // curly double quotes → "
  .replace(/[–—]/g, '-')      // en-dash / em-dash → -
  .replace(/ /g, ' ')             // non-breaking space → space
  .replace(/[^\x00-\x7F]/g, '');       // drop everything else

let recordnumber = 100000;

function postparse_write(postparsed) {
  // Wrap [REF ...] placeholders in run boundaries so they can be replaced cleanly.
  const placeholders = postparsed.filter(bit => bit.type === 'placeholder' && bit.module === moduleName);
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

  const fieldcodes = postparsed.filter(bit => bit.type === 'content' && bit.value.includes(CSL_FIELDCODE));
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
      console.log('Failed to parse CSL JSON:', json_part[1]);
      continue;
    }

    // Extract PMID/DOI from note field if not already present.
    csl.data.citationItems = csl.data.citationItems.map(item => {
      if (!item.itemData.note) return item;
      if ((item.itemData.note.includes('PMID') && !item.itemData.PMID) ||
          (item.itemData.note.includes('DOI')  && !item.itemData.DOI)) {
        const note_info = item.itemData.note.match(/((?:DOI|PMID)):\s*(\S*)/);
        if (note_info) item.itemData[note_info[1]] = note_info[2];
      }
      return item;
    });

    postparsed.splice(
      postparsed.indexOf(field_start),
      postparsed.indexOf(field_end) - postparsed.indexOf(field_start) + 1,
      { value: csl, type: 'placeholder', module: moduleName }
    );
  }
}

function render_write(csl) {
  if (!csl || !csl.citationItems || csl.citationItems.length < 1) return null;

  let endnote_xml = '<EndNote>' + csl.citationItems.map(item => {
    if (!item.recordnumber) { item.recordnumber = recordnumber++; }
    const pmid   = item.itemData.PMID || '';
    const doi    = item.itemData.DOI  || '';
    const year   = String(item.itemData.issued?.['date-parts']?.[0]?.[0] ?? '2025');
    const author = sanitize(item.itemData.author?.[0]?.family ?? 'Unknown');
    const title  = sanitize(item.itemData.title ?? '');
    const display = pmid || doi;

    const doi_text  = doi  ? `<electronic-resource-num>${doi}</electronic-resource-num>` : '';
    const pmid_text = pmid
      ? `<accession-num>${pmid}</accession-num>` +
        `<urls><related-urls><url>https://www.ncbi.nlm.nih.gov/pubmed/${pmid}</url></related-urls></urls>` +
        `<remote-database-name>Medline</remote-database-name>` +
        `<remote-database-provider>NLM</remote-database-provider>`
      : '';
    return `<Cite>
<Author>${author}</Author>
<Year>${year}</Year>
<RecNum>${item.recordnumber}</RecNum>
<DisplayText>${display}</DisplayText>
<record>
  <ref-type name="Journal Article">17</ref-type>
  <foreign-keys><key app="EN" db-id="blag">${item.recordnumber}</key></foreign-keys>
  <rec-number>${item.recordnumber}</rec-number>
  <titles><title>${title}</title></titles>
  <dates><year>${year}</year></dates>
  ${pmid_text}
  ${doi_text}
</record>
</Cite>`;
  }).join('') + '</EndNote>';

  // Encode the EN.CITE XML for embedding as an XML text node (instrText).
  // & must be encoded first to avoid double-encoding the sequences added next.
  endnote_xml = endnote_xml
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const addin_text = ` ADDIN EN.CITE ${endnote_xml}`;
  const citation_text = csl.citationItems
    .map(item => item.itemData.PMID ? `PMID:${item.itemData.PMID}` : (item.itemData.DOI ? `DOI:${item.itemData.DOI}` : null))
    .filter(Boolean).join(', ');
  const codeid = Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0').toUpperCase();

  return {
    value:
      `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="begin" w:fldLock="0" w:dirty="0"/></w:r>` +
      `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:instrText xml:space="preserve">${addin_text}</w:instrText></w:r>` +
      `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r w:rsidR="${codeid}" w:rsidRPr="${codeid}"><w:rPr><w:noProof/><w:highlight w:val="yellow"/></w:rPr>` +
      `<w:t>[REF ${citation_text}]</w:t></w:r>` +
      `<w:r w:rsidR="${codeid}"><w:rPr></w:rPr><w:fldChar w:fldCharType="end"/></w:r>`
  };
}

// ── Module ───────────────────────────────────────────────────────────────────

const endnoteCitationModule = {
  name: 'EndnoteCitationModule',
  prefix: PREFIX,
  // Set to 'read' (EN.CITE → [REF PMID:xxx]) or 'write' (CSL_CITATION → EN.CITE)
  mode: 'read',

  parse(placeHolderContent) {
    return { type: 'placeholder', value: placeHolderContent.trim(), module: moduleName };
  },

  postparse(postparsed, options) {
    this.tables = find_tables(postparsed);
    const placeholders = postparsed.filter(bit => bit.type === 'placeholder' && bit.module === moduleName);
    this.tables = this.tables.concat([find_pmids(placeholders)]);

    if (this.mode === 'read') {
      postparse_read(postparsed);
    } else {
      postparse_write(postparsed);
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

  async resolve(part, options) {
    if (part.module !== moduleName) return null;

    if (this.mode === 'read') {
      // All data extracted in postparse; no fetch needed.
      return part.value;
    }

    // write mode: CSL_CITATION field codes have CslData already; [REF...] tags need a fetch.
    if (part.value instanceof CslData) {
      return part.value.data;
    }
    const all_ids = part.value.split(',').map(id => id.replace(/\s+/g, '_').toLowerCase());
    const values = all_ids.map(id => ({
      id,
      lookup: options.scopeManager.getValue(id, { part })
    }));
    return generate_csl_from_template(values);
  },

  render(part, options) {
    if (part.module !== moduleName) return null;

    const resolvedItem = (options.resolved || []).find(r => r.lIndex === part.lIndex);
    const data = resolvedItem ? resolvedItem.value : null;

    if (this.mode === 'read') {
      return render_read(data, part);
    } else {
      return render_write(data) || {
        value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r>`
      };
    }
  }
};

export default endnoteCitationModule;
