#!/usr/bin/env node

import PizZip from 'pizzip';

import Docxtemplater from 'docxtemplater';

import path from 'path';

import fs from 'fs';


import fieldcode from './js/fieldcode.mjs';

//Load the docx file as a binary
const content = fs
    .readFileSync( path.resolve(process.cwd(), process.argv[2]), 'binary');

let data = {};

let readonly = false;

if ( process.argv[3] ) {
    const rawdata = fs.readFileSync(path.resolve(process.cwd(), process.argv[3]));
    data = JSON.parse(rawdata);
} else {
    readonly = true;
}

const zip = new PizZip(content);

const doc = new Docxtemplater();
doc.attachModule(fieldcode);
doc.loadZip(zip);

doc.setData(data);

try {
    // render the document (replace all occurences of {first_name} by John, {last_name} by Doe, ...)
    doc.render()
}
catch (error) {
    let e = {
        message: error.message,
        name: error.name,
        stack: error.stack,
        properties: error.properties,
    }
    console.log(JSON.stringify({error: e}));
    // The error thrown here contains additional information when logged with JSON.stringify (it contains a property object).
    throw error;
}

if ( ! readonly ) {

    const buf = doc.getZip()
                 .generate({type: 'nodebuffer'});

    // buf is a nodejs buffer, you can either write it to a file or do anything else with it.
    fs.writeFileSync(path.resolve(process.cwd(), process.argv[2]), buf);
}