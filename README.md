```
curl -O 'https://europepmc.org/pub/databases/pmc/DOI/PMID_PMCID_DOI.csv.gz'
gzcat PMID_PMCID_DOI.csv.gz| cat <(echo -e ".mode csv\n.import /dev/stdin mappings"\ncreate index pmids on mappings(PMID);\ncreate index dois on mappings(DOI);) - | sqlite3 pmid_mapping.sqlite
```
