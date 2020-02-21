const moduleName = "cslcitation";

const FIELDCODE = 'CSL_CITATION';
const PREFIX = '';

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


const cslCitationModule = {
  name: "CslCitationModule",
  prefix: PREFIX,
  parse(placeHolderContent) {
    const type = "placeholder";
    console.log(placeHolderContent.trim());
    return { type, value: placeHolderContent.trim(), module: moduleName };
  },
  postparse(postparsed,options) {


    this.tables = find_tables(postparsed);

    let placeholders = postparsed.filter( bit => bit.type === 'placeholder' && bit.module === moduleName);

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

      continue;

      let field_start = find_run_start(postparsed,field);
      let field_end = find_run_end(postparsed,field);
      let whole_value = postparsed.slice(postparsed.indexOf(field_start), postparsed.indexOf(field_end)).map( item => item.value ).join('');
      let json_part = whole_value.match(/ADDIN CSL_CITATION\s*([^<]+)/);
      if( ! json_part) {
        continue;
      }
      let csl_existing = JSON.parse(json_part[1]);
      for (let item of csl_existing.citationItems) {
        if (! item.id.match(/^NICKNAME/)) {
          continue;
        }
        if (item.itemData.DOI) {
        }
      }
      console.log(csl_existing);
      let code_matcher = new RegExp(`id":"NICKNAME([^"]+)"`);
      let valuetext = field.value.match(code_matcher);
      let doi_matcher = new RegExp('DOI":"([^"]+)"');
      if ( ! valuetext ) {
        let doi_match = field.value.match(doi_matcher);
        if (doi_match) {
          valuetext = [null,{ DOI: doi_match[1] }];
        }
        let uuid_match = field.value.match(/uuid=([a-z0-9\-]+)"/g);
        if (uuid_match) {
          valuetext[1].uuid = uuid_match.map( match => match.replace('"',''));
        }
      } else {
        valuetext = [ null, { nickname: valuetext[1] }]
        let uuid_match = field.value.match(/uuid=([a-z0-9\-]+)"/g);
        if (uuid_match) {
          valuetext[1].uuid = uuid_match.map( match => match.replace('"',''));
        }
      }
      if ( ! valuetext ) {
        postparsed.splice(postparsed.indexOf(field),1);
        continue;
      }
      let removed = postparsed.slice(postparsed.indexOf(field_start), postparsed.indexOf(field_end)+1);
      let removed_field_codes = removed.filter( bit => bit.type === 'content' && bit.value.indexOf(FIELDCODE) >= 0 );
      if (removed_field_codes.length > 1 || removed_field_codes[0] !== field) {
        removed_field_codes.filter( bit => bit !== field ).forEach( fld => {
          if (fld.value === field.value) {
            fld.removed = true;
          }
        });
        if (removed_field_codes.filter( bit => bit !== field && ! bit.removed ).length > 0) {
          console.log('Removing ',field, postparsed.indexOf(field_start), postparsed.indexOf(field_end) - postparsed.indexOf(field_start)+1);
          console.log(removed.slice(0,40));
          console.log('********------***********');
          console.log(postparsed.indexOf(field));
          console.log(postparsed.slice( postparsed.indexOf(field) - 20, postparsed.indexOf(field) + 20 ));
          throw new Error('Removing too much');
        }
      }
      postparsed.splice(postparsed.indexOf(field_start),postparsed.indexOf(field_end) - postparsed.indexOf(field_start)+1,{
        value: valuetext[1],
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
          options.scopeManager.scopeList.push( table.reduce((curr,row) => { curr[row.reference.toLowerCase()] = row.doi || row.pmid; return curr; } ,{}) );
        }
      }
    }

    let uuid = null;
    if (typeof part.value !== 'string') {
      uuid = part.value.uuid;
      if ( part.value.nickname ) {
        part.value = part.value.nickname;
      }
      Object.keys(options.scopeManager.scopeList[0]).forEach(function(key) {
        let value = options.scopeManager.scopeList[0][key];
        if (value === part.value.DOI) {
          part.value = key;
        }
      });
    }

    let part_id = part.value.replace(/\s+/g,'_').toLowerCase();

    let all_pmids=[];
    let re = /PMID[:_]\s*(\d+)/g;
    let matchval;
    while (matchval = re.exec(part.value)) {
      all_pmids.push(matchval[1])
      // part_id = 'PMID_'+PMID;
    }

    console.log(all_pmids);

    let value = options.scopeManager.getValue(part_id, { part });

    let DOI = value;

    if (value == null) {
      value = options.nullGetter(part);
    }

    if (! DOI && all_pmids.length < 1) {
      return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r>` };
    }

    let codeid= FIELDCODE+(new Date().getTime());

    citationItems = all_pmids.concat( DOI ).filter( val => val ).map( (idval) => {
      let part_id = idval.match(/^\d+$/) ? `PMID_${idval}` : part.value.replace(/\s+/g,'_').toLowerCase();
      const csl = {
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
      if (part_id.indexOf('PMID') == 0) {
        csl.PMID = idval;
      } else {
        csl.DOI = idval;
      }

      return {
        "id": "NICKNAME"+part_id,
        "itemData": csl,
        "uris" : [ `http://www.mendeley.com/documents/?uuid=${part_id}` ]
      };
    });

    console.log(citationItems);

    const csl_dat = {
    citationItems,
    "mendeley": {
        "formattedCitation": `[REF ${all_pmids.length > 0 ? part.value : part_id}]`,
        "plainTextFormattedCitation": `[REF ${all_pmids.length > 0 ? part.value : part_id}]`
    },
    "properties": {
        "noteIndex": 0
    },
    "schema": "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"
    };
    if ( uuid ) {
      csl_dat.citationItems[0].uris = [...new Set([`http://www.mendeley.com/documents/?uuid=${part_id}` ].concat( uuid.map( id => `http://www.mendeley.com/documents/?${id}` ) ))];
    }
    let csl_json = JSON.stringify(csl_dat);
    // csl_json = '<EndNote><Cite><record><electronic-resource-num>123.456/a.b.c</electronic-resource-num></record></Cite></EndNote>'.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // FIELDCODE='EN.CITE'
    value = `<w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"begin\" w:fldLock=\"1\"/></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:instrText xml:space="preserve">ADDIN ${FIELDCODE} ${csl_json}</w:instrText></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r w:rsidR=\"${codeid}\" w:rsidRPr=\"${codeid}\"><w:rPr><w:noProof/><w:highlight w:val="yellow"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"end\"/></w:r>`;
    return { value };
  }
};

module.exports = cslCitationModule;
