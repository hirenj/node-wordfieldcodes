#!/usr/bin/env node

import PizZip from 'pizzip';

import Docxtemplater from 'docxtemplater';

import path from 'path';

import fs from 'fs';

import fieldcode from './js/cslfieldcode.mjs';

fieldcode.writer = null;
fieldcode.writer = 'csl';
//fieldcode.writer = 'endnote';

//Load the docx file as a binary
const content = fs
    .readFileSync( path.resolve(process.cwd(), process.argv[2]), 'binary');

const rawdata = process.argv[3] ? fs.readFileSync(path.resolve(process.cwd(), process.argv[3])) : null;

const data = rawdata ? JSON.parse(rawdata) : {};

const zip = new PizZip(content);

// Auto-fix malformed tag variants: [PMID:..], [ DOI:..], (PMID:..), (DOI:..), etc. → [REF PMID:..] / [REF DOI:..]
// Excludes '<' from content match to avoid spanning across XML element boundaries.
let totalFixed = 0;
zip.filter((relPath) => relPath.startsWith('word/') && relPath.endsWith('.xml'))
   .forEach((file) => {
       const xmlContent = file.asText();
       const fixed = xmlContent.replace(/[\[(]\s*((?:PMID|DOI)[^<\])\n]*)[\])]/gi, '[REF $1]');
       if (fixed !== xmlContent) {
           totalFixed += (xmlContent.match(/[\[(]\s*(?:PMID|DOI)/gi) || []).length;
           zip.file(file.name, fixed);
       }
   });
if (totalFixed > 0) {
    process.stderr.write(`Note: auto-fixed ${totalFixed} tag(s) to "[REF ...]" format\n`);
}

const doc = new Docxtemplater();
doc.attachModule(fieldcode);
doc.loadZip(zip).setOptions({delimiters:{start:'[REF',end:']'}});

const objectKeysToLowerCase = function (origObj) {
    return Object.keys(origObj).reduce(function (newObj, key) {
        let val = origObj[key];
        let newVal = (typeof val === 'object') ? objectKeysToLowerCase(val) : val;
        newObj[key.toLowerCase()] = newVal;
        return newObj;
    }, {});
};

doc.setData(objectKeysToLowerCase(data));

// Endnote xml format for a single DOI?
// ADDIN EN.CITE <xml><records><record><electronic-resource-num>123.456/a.b.c</electronic-resource-num></record></records></xml>


try {
    await doc.renderAsync();
}
catch (error) {
    const errors = error.properties && error.properties.errors
        ? error.properties.errors
        : (error.properties ? [error] : null);

    if (errors) {
        process.stderr.write(`Template error in "${process.argv[2]}":\n\n`);
        for (const e of errors) {
            const p = e.properties || {};
            process.stderr.write(`  ${p.explanation || e.message}\n`);
            if (p.context) {
                process.stderr.write(`\n  Context:\n    ...${p.context}\n`);
            }
            if (p.file) {
                process.stderr.write(`\n  Location: ${p.file}, offset ${p.offset}\n`);
            }
            process.stderr.write('\n');
        }
    } else {
        process.stderr.write(`Error: ${error.message}\n`);
    }
    process.exit(1);
}

const buf = doc.getZip()
             .generate({type: 'nodebuffer'});

// buf is a nodejs buffer, you can either write it to a file or do anything else with it.
fs.writeFileSync(path.resolve(process.cwd(), process.argv[2]), buf);