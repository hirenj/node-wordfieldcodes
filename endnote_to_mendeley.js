#!/usr/bin/env node

const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const path = require('path');
const fs = require('fs');

const fieldcode = require('./js/endnotefieldcode');

(async () => {
    const content = fs.readFileSync(path.resolve(process.cwd(), process.argv[2]), 'binary');
    const rawdata = process.argv[3] ? fs.readFileSync(path.resolve(process.cwd(), process.argv[3])) : null;
    const data = rawdata ? JSON.parse(rawdata) : {};

    const zip = new PizZip(content);

    const objectKeysToLowerCase = (origObj) =>
        Object.keys(origObj).reduce((newObj, key) => {
            const val = origObj[key];
            newObj[key.toLowerCase()] = (typeof val === 'object') ? objectKeysToLowerCase(val) : val;
            return newObj;
        }, {});

    // Delimiters are set to never match so docxtemplater's normal tag parsing
    // stays out of the way — endnotefieldcode discovers field codes itself in postparse.
    const doc = new Docxtemplater(zip, {
        modules: [fieldcode],
        delimiters: { start: 'BLAHREF', end: 'BLAH' },
    });

    try {
        await doc.renderAsync(objectKeysToLowerCase(data));
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
})();
