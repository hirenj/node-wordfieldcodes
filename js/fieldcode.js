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

const find_run_start = (elements,start) => {
  let previous = elements.slice(0,start).reverse();
  let tag = previous.filter( tag => tag.value.indexOf('w:fldCharType="begin"') >= 0 )[0];
  previous = previous.slice(previous.indexOf(tag));
  while (tag.tag !== 'w:r') {
    tag = previous.shift();
  }
  return tag;
};

const find_run_end = (elements,start) => {
  let nextels = elements.slice(start);
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

const fieldCodeModule = {
  name: "FieldCodeModule",
  prefix: PREFIX,
  readonly: false,
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
      let field_start = find_run_start(postparsed,postparsed.indexOf(field));
      let field_end = find_run_end(postparsed,postparsed.indexOf(field));
      let code_matcher = new RegExp(`\{${PREFIX}([^\}]+)\}`);
      let field_chunk_values = postparsed.slice(postparsed.indexOf(field_start),postparsed.indexOf(field_end)).map( v => v.value );
      let directive = field_chunk_values.filter( val => val.match(/instrText/) ).map( val => val.replace(/<\/?w:instrText>/g,'')).join('');
      let valuetext = directive.match(code_matcher);
      // let textel = find_nexttextel(postparsed.slice(field.lIndex+1),tagid);
      // if ( ! textel ) {
      //   continue;
      // }
      postparsed.splice(postparsed.indexOf(field_start),postparsed.indexOf(field_end) - postparsed.indexOf(field_start)+1,{
        value: valuetext[1],
        type: 'placeholder',
        module: moduleName
      });

      // console.log(textel);
      // postparsed[postparsed.indexOf(textel)] = {
      //   value: valuetext[1],
      //   type: 'placeholder',
      //   offset: textel.offset
      // }
    }
    return { postparsed: postparsed, errors: [] };
  },
  render(part, options) {
    if (part.module !== moduleName) {
      return null;
    }

    let part_varname = part.value;
    let format = '%s';
    if (part_varname.indexOf('#') >= 0) {
      [part_varname,format] = part_varname.split('#');
    }
    let value = options.scopeManager.getValue(part_varname, { part });

    let formatted_value = value;
    if (format === '%s') {
      formatted_value = value;
    }
    if (format === '%d') {
      formatted_value = parseFloat(value).toLocaleString('en-UK');
    }
    let signif,signiftype;
    if (([,signif,signiftype]=(format.match(/%.(\d)(f|g)/)||new Array())) && signif ) {
      let opts = {};
      if (signiftype === 'f') {
        opts.minimumFractionDigits = signif;
        opts.maximumFractionDigits = signif;
      }
      if (signiftype === 'g') {
        opts.minimumSignificantDigits = signif;
        opts.maximumSignificantDigits = signif;
      }
      formatted_value = parseFloat(value).toLocaleString('en-UK',opts);
    }
    console.log('Part value',part_varname,formatted_value);

    if (value == null) {
      return { value: `<w:r><w:rPr><w:noProof/><w:highlight w:val="red"/></w:rPr><w:t>{${PREFIX}${part.value}}</w:t></w:r>` };
    }
    if (!value) {
      return { value: part.emptyValue || "" };
    }
    let codeid= FIELDCODE+(new Date().getTime());
    let value_tags = `<w:r><w:rPr></w:rPr><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"begin\" w:fldLock=\"1\"/></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:instrText>ADDIN ${FIELDCODE} {${PREFIX}${part.value}}</w:instrText></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r w:rsidR=\"${codeid}\" w:rsidRPr=\"${codeid}\"><w:rPr><w:highlight w:val="yellow"/><w:noProof/></w:rPr><w:t>${formatted_value}</w:t></w:r><w:r w:rsidR=\"${codeid}\"><w:rPr></w:rPr><w:fldChar w:fldCharType=\"end\"/></w:r></w:r>`;
    return { value: value_tags };
  }
};

module.exports = fieldCodeModule;
