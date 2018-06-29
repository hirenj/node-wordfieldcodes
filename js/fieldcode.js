const moduleName = "fieldcode";

const FIELDCODE = 'JSONDATA';
const PREFIX = '%';

const find_runid = (elements,start) => {
  let previous = elements.slice(0,start).reverse();
  let tag = previous.filter( tag => tag.value.indexOf('w:fldChar') >= 0 )[0];
  if ( ! tag ) {
    throw new Error('Cant find tag');
  }
  tag = elements[elements.indexOf(tag) - 1];
  if (tag.value.match(/rsidR="([^\"]+)"/)) {
    return tag.value.match(/rsidR="([^\"]+)"/)[1];
  } else {
    return null;
  }
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

const fieldCodeModule = {
  name: "FieldCodeModule",
  prefix: PREFIX,
  parse(placeHolderContent) {
    const type = "placeholder";
    if (placeHolderContent[0] !== this.prefix) {
      return null;
    }
    return { type, value: placeHolderContent.substr(1), module: moduleName };
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
      let tagid = find_runid(postparsed,field.lIndex);
      let code_matcher = new RegExp(`\{${PREFIX}([^\}]+)\}`);
      let valuetext = field.value.match(code_matcher);
      let textel = find_nexttextel(postparsed.slice(field.lIndex+1),tagid);
      if ( ! textel ) {
        continue;
      }
      postparsed[postparsed.indexOf(textel)] = {
        value: valuetext[1],
        type: 'placeholder',
        offset: textel.offset
      }
    }
    return { postparsed: postparsed, errors: [] };
  },
  render(part, options) {
    if (part.module !== moduleName) {
      return null;
    }
    let value = options.scopeManager.getValue(part.value, { part });
    if (value == null) {
      value = options.nullGetter(part);
    }
    if (!value) {
      return { value: part.emptyValue || "" };
    }
    let codeid= FIELDCODE+(new Date().getTime());
    value = `<w:r><w:rPr></w:rPr><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"begin\" w:fldLock=\"1\"/></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:instrText>ADDIN ${FIELDCODE} {${PREFIX}${part.value}}</w:instrText></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r w:rsidR=\"${codeid}\" w:rsidRPr=\"${codeid}\"><w:rPr><w:noProof/></w:rPr><w:t>${value}</w:t></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"end\"/></w:r></w:r>`;
    return { value };
  }
};

module.exports = fieldCodeModule;
