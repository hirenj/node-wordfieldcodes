#!/usr/bin/env node

import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import path from 'path';
import fs from 'fs';

import endnoteModule from './js/endnotefieldcode.mjs';

// Usage: endnote_to_mendeley.mjs <file.docx> [read|write]
//   read  (default) EN.CITE → [REF PMID:xxx] intermediate format
//   write            CSL_CITATION → EN.CITE field codes
const mode = process.argv[3] || 'read';
if (mode !== 'read' && mode !== 'write') {
  process.stderr.write(`Unknown mode "${mode}". Use "read" (EN.CITE → intermediate) or "write" (CSL → EN.CITE).\n`);
  process.exit(1);
}
endnoteModule.mode = mode;

const content = fs.readFileSync(path.resolve(process.cwd(), process.argv[2]), 'binary');
const zip = new PizZip(content);

// Bogus delimiters so docxtemplater's tag parser never fires;
// the endnote module discovers field codes itself in postparse.
const doc = new Docxtemplater(zip, {
  modules: [endnoteModule],
  delimiters: { start: 'BLAHREF', end: 'BLAH' },
});

try {
  await doc.renderAsync({});
} catch (error) {
  const errors = error.properties && error.properties.errors
    ? error.properties.errors
    : (error.properties ? [error] : null);

  if (errors) {
    process.stderr.write(`Template error in "${process.argv[2]}":\n\n`);
    for (const e of errors) {
      const p = e.properties || {};
      process.stderr.write(`  ${p.explanation || e.message}\n`);
      if (p.context) process.stderr.write(`\n  Context:\n    ...${p.context}\n`);
      if (p.file)    process.stderr.write(`\n  Location: ${p.file}, offset ${p.offset}\n`);
      process.stderr.write('\n');
    }
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
  }
  process.exit(1);
}

const buf = doc.getZip().generate({ type: 'nodebuffer' });
fs.writeFileSync(path.resolve(process.cwd(), process.argv[2]), buf);
