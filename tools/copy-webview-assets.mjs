import fs from 'node:fs';
fs.mkdirSync('dist/vendor',{recursive:true});
fs.copyFileSync('node_modules/@mermaid-js/tiny/dist/mermaid.tiny.js','dist/vendor/mermaid.js');
fs.copyFileSync('node_modules/@mermaid-js/tiny/LICENSE','dist/vendor/MERMAID-LICENSE');
