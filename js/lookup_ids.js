 
const db = require('better-sqlite3')('./pmid_mapping.sqlite');

const pmid_query = db.prepare('SELECT DOI FROM mappings WHERE PMID = ?');

const doi_query = db.prepare('SELECT PMID FROM mappings WHERE DOI = ?');


exports.search_by_doi = function(doi) {
  let query_doi = doi;
  if (query_doi.indexOf('http') < 0) {
  	query_doi = `https://doi.org/${doi}`;
  }
  return doi_query.get(query_doi+"");
}
 
exports.search_by_pmid = function(pmid) {
  if ((pmid+'') == '28876859') { 
  	return {DOI:'https://doi.org/10.1101/glycobiology.3e.038'};
  }
  return pmid_query.get(pmid+"");
}
