import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('bridge-output',{recursive:true}); writeFileSync('bridge-output/report.json','{}'); writeFileSync('bridge-output/unexpected.txt','bad');
