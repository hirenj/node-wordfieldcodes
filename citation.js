#!/usr/bin/env node

const JSZip = require('jszip');
const Docxtemplater = require('docxtemplater');

const path = require('path');

const fs = require('fs');


var fieldcode = require('./js/cslfieldcode');

//Load the docx file as a binary
const content = fs
    .readFileSync( path.resolve(process.cwd(), process.argv[2]), 'binary');

const rawdata = process.argv[3] ? fs.readFileSync(path.resolve(process.cwd(), process.argv[3])) : null;

const data = rawdata ? JSON.parse(rawdata) : {};

const zip = new JSZip(content);

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

const buf = doc.getZip()
             .generate({type: 'nodebuffer'});

// buf is a nodejs buffer, you can either write it to a file or do anything else with it.
fs.writeFileSync(path.resolve(process.cwd(), process.argv[2]), buf);