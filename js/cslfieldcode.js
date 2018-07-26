const moduleName = "cslcitation";

const FIELDCODE = 'CSL_CITATION';
const PREFIX = '';

const find_run_start = (elements,start_el) => {
  let previous = elements.slice(0,elements.indexOf(start_el)).reverse();

  let tag = previous.filter( tag => tag.value && (typeof tag.value == 'string') && tag.value.indexOf('w:fldCharType="begin"') >= 0 )[0];
  previous = previous.slice(previous.indexOf(tag));
  while (tag.tag !== 'w:r') {
    tag = previous.shift();
  }
  return tag;
};

const find_run_end = (elements,start_el) => {
  let nextels = elements.slice(elements.indexOf(start_el));
  let tag = nextels.filter( tag => tag.value.indexOf('w:fldCharType="end"') >= 0 )[0];
  return nextels[nextels.indexOf(tag)+1];
};

const find_nexttextel = (elements,tagid) => {
  tagid = tagid || '';
  let next = elements.filter( tag => tag.value.indexOf('w:fldCharType="separate"') >= 0);
  if (next.length < 1) {
    return;
  }
  let start_r = elements.slice(elements.indexOf(next[0])).filter( tag => tag.tag == 'w:r' && tag.position === 'start')[0];
  let start_idx = elements.indexOf(start_r);
  let start_text = elements.slice(start_idx).filter( (tag,idx) => tag.tag === 'w:t' && tag.position === 'start' );
  return elements[elements.indexOf( start_text[0] )+1 ];
}

const cslCitationModule = {
  name: "CslCitationModule",
  prefix: PREFIX,
  parse(placeHolderContent) {
    const type = "placeholder";
    console.log(placeHolderContent.trim());
    return { type, value: placeHolderContent.trim(), module: moduleName };
  },
  postparse(postparsed) {
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
      let field_start = find_run_start(postparsed,field);
      let field_end = find_run_end(postparsed,field);
      let code_matcher = new RegExp(`id":"NICKNAME([^"]+)"`);
      let valuetext = field.value.match(code_matcher);
      let doi_matcher = new RegExp('DOI":"([^"]+)"');
      if ( ! valuetext ) {
        let doi_match = field.value.match(doi_matcher);
        if (doi_match) {
          valuetext = [null,{ DOI: doi_match[1] }];
        }
        let uuid_match = field.value.match(/uuid=([a-z0-9\-]+)"/);
        if (uuid_match) {
          valuetext[1].uuid = uuid_match[1];
        }
      } else {
        valuetext = [ null, { nickname: valuetext[1] }]
        let uuid_match = field.value.match(/uuid=([a-z0-9\-]+)"/);
        if (uuid_match) {
          valuetext[1].uuid = uuid_match[1];
        }
      }
      if ( ! valuetext ) {
        postparsed.splice(postparsed.indexOf(field),1);
        continue;
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
    let value = options.scopeManager.getValue(part_id, { part });

    if (value == null) {
      value = options.nullGetter(part);
    }
    if (!value) {
      return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r>` };
    }
    let codeid= FIELDCODE+(new Date().getTime());
    const csl = {
      "DOI": value || "1.2.3/abc",
    };
    const csl_dat = { "citationItems": [{
      "id": "NICKNAME"+part_id,
      "itemData": csl
    }],
    "schema": "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"
    };
    if ( uuid ) {
      csl_dat.citationItems[0].uris = [`http://www.mendeley.com/documents/?uuid=${uuid}`];
    }
    let csl_json = JSON.stringify(csl_dat);
    // csl_json = '<EndNote><Cite><record><electronic-resource-num>123.456/a.b.c</electronic-resource-num></record></Cite></EndNote>'.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // FIELDCODE='EN.CITE'
    value = `<w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"begin\" w:fldLock=\"1\"/></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:instrText xml:space="preserve"> ADDIN ${FIELDCODE} ${csl_json}</w:instrText></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r w:rsidR=\"${codeid}\" w:rsidRPr=\"${codeid}\"><w:rPr><w:noProof/><w:highlight w:val="yellow"/></w:rPr><w:t>[REF ${part.value}]</w:t></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"end\"/></w:r>`;
    return { value };
  }
};

module.exports = cslCitationModule;
