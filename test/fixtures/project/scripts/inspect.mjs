import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const id=process.argv[2];
const root=process.env.TEST_DATA_DIR;
const sample=readFileSync(`${root}/catalog/${id}.txt`,'utf8').trim();
mkdirSync('bridge-output',{recursive:true});
const report={dataset_id:id,sample,root};
writeFileSync('bridge-output/report.json',JSON.stringify(report));
writeFileSync('bridge-output/sample.txt',sample+'\n');
console.log(JSON.stringify({dataset_id:id,ok:true,root}));
