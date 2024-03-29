const moduleName = "cslcitation";

const FIELDCODE = 'CSL_CITATION';
const PREFIX = '';

const fetch = require('node-fetch');
const deasync = require('deasync');

var cleanup = require('./cleanup').Cleanup(jsonWrite);

const fs = require('fs');
const cached_results_doi = JSON.parse(fs.readFileSync('./cached_data.json', 'utf8'));

function jsonWrite() {
  fs.writeFileSync('./cached_data.json', JSON.stringify(cached_results_doi), 'utf8');
}

class CslData {
  constructor(data) {
    this.data = data;
  }
}

class DOI {
  constructor(value,identifier) {
    this.value = value;
    this.identifier = identifier;
  }
}

class PMID {
  constructor(value,identifier) {
    this.value = value;
    this.identifier = identifier;
  }
}

const just_seen_error = {};

const retrieve_csl_for_doi = async (doi) => {
  let crossref_data;
  if ( ! just_seen_error[doi] && cached_results_doi[doi] && cached_results_doi[doi].error ) {
    delete cached_results_doi[doi];
  }
  try {
    if (cached_results_doi[doi]) {
      crossref_data = cached_results_doi[doi];  
    } else {
      console.log(`Fetching fresh CSL for ${doi}`);
      let clean_doi = doi;
      if (clean_doi.indexOf('https://doi.org/') == 0) {
        clean_doi = clean_doi.replace('https://doi.org/','');
      }
      crossref_data = await fetch(`https://dx.doi.org/${clean_doi}`, { headers: { 'Accept': 'application/citeproc+json' } }).then( res => res.json() );
    }
  } catch (err) {
    if (err.type == 'invalid-json') {
      crossref_data = { "DOI" : doi, "error" : true };
    } else {
      throw err;
    }
  }
  delete crossref_data.license;
  delete crossref_data.reference;
  if ((crossref_data['type'] || '').indexOf('article') >= 0) {
    crossref_data['type'] = 'article-journal';
  }
  cached_results_doi[doi] = crossref_data;
  if (! crossref_data['type']) {
    just_seen_error[doi] = true;
  }
  return crossref_data;
};

const cached_results_pmid = [];

const sleep_wait = async (time) => {
  return new Promise( resolve => {
    setTimeout(resolve,time);
  });
};

const fetch_pmid_doi_data = async (pmid) => {
  let pmid_data = cached_results_pmid[pmid] ? cached_results_pmid[pmid] : await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`).then( res => res.json() );
  if ( ! pmid_data || ! ('result' in pmid_data) || ! (pmid in pmid_data.result) ) {
    if (tries > 0) {
      await sleep_wait(500);
      console.log(`Trying to retrieve again for PMID ${pmid}`);
      return await retrieve_csl_for_pmid(pmid,tries-1);
    } else {
      console.log(`Failed to retrieve data from eutils for PMID ${pmid}`);
      return;
    }
  }
  if (pmid_data.result[pmid]) {
    cached_results_pmid[pmid] = pmid_data;
  }
  let doi = pmid_data.result[pmid].articleids.filter( anid => anid.idtype == 'doi' ).map( id => id.value )[0];
  return doi;
}

const retrieve_csl_for_pmid = async (pmid,tries=2) => {
  let doi = require('./lookup_ids').search_by_pmid(pmid);
  if ( ! doi ) {
    console.log(`Retrieving CSL for ${pmid}`);
    doi = await fetch_pmid_doi_data(pmid);
  } else {
    console.log(`Using library DOI for ${pmid}`);
    doi = doi.DOI;
  }
  console.log(`"${pmid}" maps to "${doi}"`);
  if ( doi ) {
    if (doi.indexOf('http') < 0) {
      doi = `https://doi.org/${doi}`;
    }
    let csl = retrieve_csl_for_doi(doi);
    if ( ! ('authors' in csl) ) {
      delete csl.DOI;
    }
    csl.PMID = pmid;
    console.log(`Done for PMID ${pmid}`);
    return csl;
  }
  return;
};

const sync_csl = function(values,callback) {
  let csl;
  let done = false;
  generate_csl_from_template(values).then( (retval) => {
    csl = retval;
    done = true;
  }).catch( err => {
    done = true;
    throw err;
  });
  deasync.loopWhile( () => ! done );
  return csl;
};

const get_entry_obj = (key,id) => {
  if (key.indexOf('DOI:') === 0) {
    return new DOI(key.replace('DOI:','').trim(),id);
  }
  if (key.indexOf('PMID:') === 0) {
    return new PMID(key.replace('PMID:','').trim(),id);
  }
};

const generate_csl_from_template = async function(values) {
  let all_ids = [];
  for (let {id,lookup} of values) {
    if (lookup) {
      all_ids.push(get_entry_obj(lookup,id));
      continue;
    }
    let re = /PMID\s*[:_][_\s]*(\d+)/gi;
    let matchval;
    while (matchval = re.exec(id)) {
      let a_pmid = matchval[1];
      all_ids.push(new PMID(a_pmid,`PMID:${a_pmid}`));
    }
    re = /DOI\s*[:_][_\s]*(.+)/gi;
    matchval;
    while (matchval = re.exec(id)) {
      let a_doi = matchval[1];
      all_ids.push(new DOI(a_doi,`DOI:${a_doi}`));
    }

  }

  let citationItems = await Promise.all(all_ids.filter( val => val ).map( async (reference) => {
    let part_id = reference.identifier.replace(/[\s:]+/g,'_').toLowerCase();
    let ref_csl = {
        "ID" :"NICKNAME"+part_id,
        "author": [
            {
                "dropping-particle": "",
                "family": part_id,
                "given": "",
                "non-dropping-particle": "",
                "parse-names": false,
                "suffix": ""
            }]
      };
    let csl = ref_csl;
    if (reference instanceof DOI) {
      csl.DOI = reference.value;
      let doi_val = reference.value;
      doi_val = doi_val.replace('.*doi.org\/','');
      csl = await retrieve_csl_for_doi(reference.value);
      csl.ID = 'NICKNAME'+part_id;
    }
    if (reference instanceof PMID) {
      csl.PMID = reference.value;
      csl = await retrieve_csl_for_pmid(reference.value);
      let tries = 3;
      while ( ! csl ) {
        if ( tries == 0) {
          csl = ref_csl;
          break;
        }
        console.log('Trying to retrieve CSL again');
        await sleep_wait(500);
        csl = await retrieve_csl_for_pmid(reference.value);
        tries = tries - 1;
      }
      csl.PMID = reference.value;
      csl.ID = 'NICKNAME'+part_id;
    }

    return {
      "id": "NICKNAME"+part_id,
      "itemData": csl,
      "uris" : [ `http://www.mendeley.com/documents/?uuid=${part_id}` ]
    };
  }));
  citationItems = citationItems.filter( item => item );

  const formatted = all_ids.map( ref => ref.identifier ).join(',');
  const csl_dat = {
    citationItems,
    "mendeley": {
        "formattedCitation": `[REF ${formatted}]`,
        "plainTextFormattedCitation": `[REF ${formatted}]`
    },
    "properties": {
        "noteIndex": 0
    },
    "schema": "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"
  };

  return csl_dat;

};

const find_run_start = (elements,start_el) => {
  let previous = elements.slice(0,elements.indexOf(start_el)).reverse();
  let tag = previous.filter( tag => tag.value && (typeof tag.value == 'string') && tag.value.indexOf('w:fldCharType="begin"') >= 0 )[0];
  previous = previous.slice(previous.indexOf(tag));
  while (tag.tag !== 'w:r' && previous.length > 0) {
    tag = previous.shift();
  }
  if (tag.tag !== 'w:r') {
    throw new Error('Couldnt find start tag for ',start_el);
  }
  return tag;
};

const find_run_end = (elements,start_el) => {
  let nextels = elements.slice(elements.indexOf(start_el));
  let tag = nextels.filter( tag => tag.value && (typeof tag.value == 'string') && tag.value.indexOf('w:fldCharType="end"') >= 0 )[0];
  return nextels[nextels.indexOf(tag)+1];
};

const find_nexttextel = (elements,tagid) => {
  tagid = tagid || '';
  let next = elements.filter( tag => tag.value &&  (typeof tag.value == 'string') && tag.value.indexOf('w:fldCharType="separate"') >= 0);
  if (next.length < 1) {
    return;
  }
  let start_r = elements.slice(elements.indexOf(next[0])).filter( tag => tag.tag == 'w:r' && tag.position === 'start')[0];
  let start_idx = elements.indexOf(start_r);
  let start_text = elements.slice(start_idx).filter( (tag,idx) => tag.tag === 'w:t' && tag.position === 'start' );
  return elements[elements.indexOf( start_text[0] )+1 ];
}


const find_tables = (postparsed) => {
  let table_starts = postparsed.filter( bit => bit.type === 'content' && bit.value.indexOf('<w:tbl>') >= 0);
  let table_indices = table_starts.map( start => {
    let start_idx = postparsed.indexOf(start);
    let end = postparsed.slice(start_idx).filter( bit => bit.type === 'content' && bit.value.indexOf('</w:tbl>') >= 0).shift();
    return {start: start_idx, end: postparsed.indexOf(end)+1};
  });

  const tables = [];

  for (let {start,end} of table_indices) {
    const table = postparsed.slice(start,end);

    const boundaries = table.filter( bit => ['w:tc','w:tr'].indexOf(bit.tag) >= 0 && bit.position === 'start').map( bit => bit.tag );
    const num_columns = boundaries.slice(1).indexOf('w:tr');
    const cellstarts = table.filter( bit => bit.tag === 'w:tc' && bit.position === 'start');
    const cell_indices = cellstarts.map( start_cell => {
      let start_idx = table.indexOf(start_cell);
      let end = table.slice(start_idx).filter( bit => bit.tag === 'w:tc' && bit.position === 'end').shift();
      return {start: postparsed.indexOf(table[start_idx]), end: postparsed.indexOf(end)+1 };
    });
    const cells = [];
    const headers = [];
    cell_indices.forEach( ({start: cell_start,end: cell_end},idx) => {
      let cell = postparsed.slice(cell_start,cell_end);
      let content = cell.filter( bit => bit.position === 'insidetag').map( bit => bit.value).join('');
      let row_num = Math.floor(idx / num_columns);
      if (row_num === 0) {
        headers.push(content.toLowerCase());
      } else {
        if ( ! cells[row_num-1]) {
          cells[row_num-1] = {};
        }
        cells[row_num-1][headers[ idx % num_columns ]] = content;
      }
    });
    tables.push(cells);
  }
  return tables;
};

const parse_pmid = (pmid) => {
  let re = /PMID[:_][_\s]*(\d+)/gi;
  let matchval;
  let a_pmid;
  while (matchval = re.exec(pmid)) {
    a_pmid = matchval[1];
  }
  if ( a_pmid ) {
    return { key: pmid.replace(/PMID\:.*/,''), pmidval: a_pmid };
  }
};

const find_pmids = (placeholders) => {
  let all_pmids = [].concat.apply([],placeholders.filter( bit => bit.value.match(/PMID/) ).map( bit => bit.value.split(',').map( v => v.trim() ) ));
  let results = [];
  for (let pmid of all_pmids) {
    let pmid_result = parse_pmid(pmid);
    if (pmid_result) {
      let {key,pmidval} = pmid_result;
      results.push( { reference: key.trim(), pmid: pmidval } );
    }
  }
  return results;
};

const document_doi_cache = {};

const cslCitationModule = {
  name: "CslCitationModule",
  prefix: PREFIX,
  parse(placeHolderContent) {
    const type = "placeholder";
    return { type, value: placeHolderContent.trim(), module: moduleName };
  },
  postparse(postparsed,options) {


    this.tables = find_tables(postparsed);

    let placeholders = postparsed.filter( bit => bit.type === 'placeholder' && bit.module === moduleName);

    this.tables = this.tables.concat(  [ find_pmids(placeholders) ] );

    for (let placeholder of placeholders) {
      postparsed.splice( postparsed.indexOf(placeholder), 0, { type: 'tag',
       position: 'end',
       text: true,
       value: '</w:t>',
       tag: 'w:t' }, { type: 'tag',
       position: 'end',
       text: false,
       value: '</w:r>',
       tag: 'w:r' } );
      postparsed.splice( postparsed.indexOf(placeholder)+1, 0, { type: 'tag',
       position: 'start',
       text: false,
       value: '<w:r>',
       tag: 'w:r' },{ type: 'tag',
       position: 'start',
       text: true,
       value: '<w:t>',
       tag: 'w:t' } );
    }

    let fieldcodes = postparsed.filter( bit => bit.type === 'content' && bit.value.indexOf(FIELDCODE) >= 0);
    for (let field of fieldcodes) {
      if ( field.removed ) {
        continue;
      }
      let field_start = find_run_start(postparsed,field);
      let field_end = find_run_end(postparsed,field);
      let whole_value = postparsed.slice(postparsed.indexOf(field_start), postparsed.indexOf(field_end)).filter( item => item.tag !== 'w:r' ).map( item => item.value ).join('');
      whole_value = whole_value.replace(/xml\:space="preserve"/g,'');
      let instr_text_re = /<w:instrText[^>]*>(([^<]|\n)*?)<\/w:instrText>/g;
      let match;
      let instr_texts = ""
      while ((match = instr_text_re.exec(whole_value)) !== null) {
        instr_texts += match[1]
      }
      if (! instr_texts) {
        continue;
      }
      let json_part = instr_texts.match(/ADDIN (?:ZOTERO_ITEM )?CSL_CITATION\s*([^<]+)/);

      if( ! json_part) {
        continue;
      }
      let csl;
      try {
        csl = new CslData(JSON.parse(json_part[1]));
      } catch (err) {
        console.log(instr_texts);
        console.log(json_part[1])
        throw err;
      }
      csl.data.citationItems = csl.data.citationItems.map( (item) => {
        if (item.itemData.DOI) {
          if (document_doi_cache[item.itemData.DOI]) {
            console.log(`Removing duplicate entry for ${item.itemData.DOI}`);
          } else {
            document_doi_cache[item.itemData.DOI] = item;
          }
          return document_doi_cache[item.itemData.DOI];
        }
        return item;
      }); 

      let removed = postparsed.slice(postparsed.indexOf(field_start), postparsed.indexOf(field_end)+1);
      postparsed.splice(postparsed.indexOf(field_start),postparsed.indexOf(field_end) - postparsed.indexOf(field_start)+1,{
        value: csl,
        type: 'placeholder',
        module: moduleName
      });
    }
    return { postparsed: postparsed, errors: [] };
  },
  render(part, options) {
    if (part.module !== moduleName) {
      return null;
    }

    if (this.tables && this.tables.length > 0) {
      for (let table of this.tables.filter( table => table.length > 0)) {
        if (table[0].reference && (table[0].doi || table[0].pmid)) {
          options.scopeManager.scopeList.push( table.reduce((curr,row) => { curr[row.reference.toLowerCase()] =  row.pmid ? `PMID:${row.pmid}` : `DOI:${row.doi}`; return curr; } ,{}) );
        }
      }
    }

    let uuid = null;
    let csl;

    if (part.value instanceof CslData) {
      csl = part.value.data;
      for (let i = 0; i < csl.citationItems.length; i++) {
        let an_item = csl.citationItems[i];
        if (an_item.id && (an_item.id+'').match(/^NICKNAME/)) {
          let id = (an_item.id+'').replace(/^NICKNAME/,'');
          let lookup = options.scopeManager.getValue(id, { part });
          let value = { id , lookup };
          csl.citationItems[i] = sync_csl([ value ]).citationItems[0];
        }
      }
    } else {
      const all_ids = part.value.split(',').map( id => id.replace(/\s+/g,'_').toLowerCase());
      let values = all_ids.map( id => {
        let lookup = options.scopeManager.getValue(id, { part });
        return { id, lookup };
      });
      csl = sync_csl(values);
    }

    if (! csl || csl.citationItems.length < 1) {
      console.log('Missing ',part.value);
      return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r>` };
    }

    let citation_text = csl.mendeley ? csl.mendeley.formattedCitation.replace('[REF ','').replace(/]$/,'') : '';

    let errors = [];

    for (let cslitem of csl.citationItems) {
      if ( ! cslitem.itemData.PMID && cslitem.itemData.DOI ) {
        let lookedup_pmid = require('./lookup_ids').search_by_doi(cslitem.itemData.DOI);
        if (lookedup_pmid) {
          cslitem.itemData.PMID = lookedup_pmid.PMID;
        }
      }
      if ( ! (cslitem.itemData.PMID || cslitem.itemData.DOI )) {
        console.log(cslitem.itemData);
      }
      if ( ! cslitem.itemData.type ) {
        if (cslitem.itemData.PMID) {
          errors.push( `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF PMID:${cslitem.itemData.PMID}]</w:t></w:r>` );
        } else {
          errors.push( `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF DOI:${cslitem.itemData.DOI}]</w:t></w:r>` );          
        }
      }
    }
    csl.citationItems = csl.citationItems.filter( cslitem => cslitem.itemData.type );

    citation_text = csl.citationItems.map( item => item.itemData.PMID ).filter( pm => pm ).map( pm => `PMID:${pm}`).join(', ');
    let super_sub_match;
    if (super_sub_match = citation_text.match(/&lt;su[pb]&gt;(.*)&lt;\/su[pb]&gt;/)) {
      citation_text = super_sub_match[1]
    }

    let codeid = FIELDCODE+(new Date().getTime());

    let csl_json = JSON.stringify(csl).replace(/&/g,'').replace(/[<>]/g,'');

    // csl_json = '<EndNote><Cite><record><electronic-resource-num>123.456/a.b.c</electronic-resource-num></record></Cite></EndNote>'.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // FIELDCODE='EN.CITE'
    value = `<w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"begin\" w:fldLock=\"1\"/></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:instrText xml:space="preserve">ADDIN ${FIELDCODE} ${csl_json}</w:instrText></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r w:rsidR=\"${codeid}\" w:rsidRPr=\"${codeid}\"><w:rPr><w:noProof/><w:highlight w:val="yellow"/></w:rPr><w:t>[REF ${citation_text}]</w:t></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"end\"/></w:r>`;
    value = value + errors.join('');
    return { value };
  }
};

module.exports = cslCitationModule;
