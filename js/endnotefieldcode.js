const moduleName = "cslcitation";

const FIELDCODE = 'EN.CITE ';
const PREFIX = '';

const fetch = require('node-fetch');
const deasync = require('deasync');

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

const cached_results_doi = [];

function decodeEntities(encodedString) {
    var translate_re = /&(nbsp|amp|quot|lt|gt);/g;
    var translate = {
        "nbsp":" ",
        "amp" : "&",
        "quot": "\"",
        "lt"  : "<",
        "gt"  : ">"
    };
    return encodedString.replace(translate_re, function(match, entity) {
        return translate[entity];
    }).replace(/&#(\d+);/gi, function(match, numStr) {
        var num = parseInt(numStr, 10);
        return String.fromCharCode(num);
    });
}


const retrieve_csl_for_doi = async (doi) => {
  let crossref_data;
  try {
    crossref_data = cached_results_doi[doi] ? cached_results_doi[doi] : await fetch(`https://dx.doi.org/${doi}`, { headers: { 'Accept': 'application/citeproc+json' } }).then( res => res.json() );
  } catch (err) {
    if (err.type == 'invalid-json') {
      crossref_data = { "DOI" : doi };
    } else {
      throw err;
    }
  }
  delete crossref_data.license;
  delete crossref_data.reference;
  crossref_data['type'] = 'article-journal';
  cached_results_doi[doi] = crossref_data;
  return crossref_data;
};

const cached_results_pmid = [];

const sleep_wait = async (time) => {
  return new Promise( resolve => {
    setTimeout(resolve,time);
  });
};


const retrieve_csl_for_pmid = async (pmid,tries=2) => {
  console.log(`Retrieving CSL for ${pmid}`);
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
  if ( doi ) {
    let csl = retrieve_csl_for_doi(doi);
    if ( ! ('authors' in csl) ) {
      delete csl.DOI;
      console.log(JSON.stringify(csl));
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
    let re = /PMID[:_][_\s]*(\d+)/gi;
    let matchval;
    while (matchval = re.exec(id)) {
      let a_pmid = matchval[1];
      all_ids.push(new PMID(a_pmid,`PMID:${a_pmid}`));
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
  while (tag && tag.tag !== 'w:r' && previous.length > 0) {
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

      let endnote_instruction;

      let base64_re = /<w:fldData[^>]*>(([^<]|\n)*?)<\/w:fldData>/g;
      let match;
      let base64_texts = []
      while ((match = base64_re.exec(whole_value)) !== null) {
        base64_texts.push(match[1])
      }

      for (let base64_text of base64_texts.reverse()) {
        let buff = new Buffer(base64_text, 'base64');
        endnote_instruction = (endnote_instruction || '' ) + buff.toString('ascii');
        // if (endnote_instruction.indexOf('<EndNote>') != 0) {
        //   console.log(whole_value);
        //   endnote_instruction = null;
        // }

      }

      let instr_text_re = /<w:instrText[^>]*>(([^<]|\n)*?)<\/w:instrText>/g;
      let instr_texts = ""
      while ((match = instr_text_re.exec(whole_value)) !== null) {
        instr_texts += match[1]
      }


      let xml_parts = instr_texts.match(/ADDIN EN.CITE\s*([^}]+)/);
      if ( ! xml_parts ) {
        continue;
      }

      if (xml_parts[1].indexOf('.DATA') >= 0) {
        xml_parts = null;
      } else if ( ! endnote_instruction ) {
        endnote_instruction = decodeEntities(xml_parts[1]);
      }
      if( ! endnote_instruction ) {
        console.log('SKIPPING ',whole_value);
        continue;
      }
      let csl;
      if (! endnote_instruction ) {
        continue;
      }

      let pubmeds = [];


      let pubmed_re = /(?:pubmed\/|accession-num>)(\d+)/g;
      let author_re = /<Author>([^<]+)<\/Author><Year>([^<]+)<\/Year>/g;

      let cite_match;

      for (let cite_text of endnote_instruction.split(/<Cite>/).filter( val => val.trim().length > 0 )) {
        let PMID, title;
        if ((match = /(?:pubmed\/|accession-num>)(\d+)/.exec(cite_text)) !== null) {
          PMID = match[1];
        }
        if ((match = /<Author>([^<]+)<\/Author><Year>([^<]+)<\/Year>/.exec(cite_text)) !== null) {
          title = match[1] + match[2];
        }

        if (PMID) {
          if (pubmeds.map( ({PMID}) => PMID ).indexOf(PMID) < 0) {
            pubmeds.push({PMID,title});
          }
        }
      }
      if (pubmeds.length < 1) {
        console.log(whole_value);
      }

      console.log(pubmeds.length);

      let removed = postparsed.slice(postparsed.indexOf(field_start), postparsed.indexOf(field_end)+1);

      postparsed.splice(postparsed.indexOf(field_start),postparsed.indexOf(field_end) - postparsed.indexOf(field_start)+1,{
        value: new CslData(pubmeds),
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
    let pubmeds;

    if (part.value instanceof CslData) {
      pubmeds = part.value.data;
    }
    if (! pubmeds || pubmeds.length < 1 ) {
      console.log('Missing ',part.value);
      return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r>` };
    }

    let pubmed_string = pubmeds.map( ({PMID,title}) => `${title || 'Unknown'} PMID:${PMID}`).join(',');
    // pubmed_string = 'PMID:1234';
    // console.log(`<w:r><w:rPr><w:noProof/><w:highlight w:val="green"/></w:rPr><w:t>[REF ${pubmed_string}]</w:t></w:r>`);
    return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="green"/></w:rPr><w:t>[REF ${pubmed_string}]</w:t></w:r>` }
  }
};

module.exports = cslCitationModule;
