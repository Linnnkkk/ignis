import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createQueries } = require('./query');
const { parseNote } = require('./metadata');
const records = [
 {path:'A.md',content:'---\ntitle: Alpha\ntags: [work/project]\n---\nhello #work [[B]]',revision:'a'},
 {path:'B.md',content:'# Beta\nhello',revision:'b'},
];
const api = createQueries({scan:()=>records,read:({path})=>records.find(n=>n.path===path),parseNote});
it('filters exact nested tags, title and literal body with explicit pagination',()=>{
 expect(api.query({tag:'work/project'}).total).toBe(1);
 expect(api.query({tag:'project'}).total).toBe(0);
 expect(api.query({query:'hello',limit:1}).nextOffset).toBe(1);
 expect(api.query({title:'beta'}).items[0].path).toBe('B.md');
 expect(api.query({pathPrefix:'folder'}).total).toBe(0);
 expect(()=>api.query({limit:101})).toThrow();
});
it('provides bounded partial reads and ATX outlines with entire-note revision', () => {
 const content = '---\ntitle: Hidden\n---\n# Visible\n```md\n## Not heading\n```\n## Next\nbody';
 const q = createQueries({scan:()=>[],read:()=>({path:'x.md',content,revision:'revision'}),parseNote});
 expect(q.outline({}).headings).toEqual([{line:4,level:1,title:'Visible'},{line:8,level:2,title:'Next'}]);
 expect(q.readLines({startLine:8,lineCount:1})).toMatchObject({content:'## Next',partial:true,truncated:true,revisionScope:'entire-note'});
 expect(()=>q.readLines({startLine:0})).toThrow();
 expect(()=>q.readLines({lineCount:301})).toThrow();
 expect(()=>q.readLines({startLine:1000})).toThrow();
});

it('extracts standard checkbox tasks but ignores frontmatter and fenced code', () => {
 const content = '---\ntitle: Tasks\n---\n- [ ] todo\n- [x] done\n```\n- [ ] hidden\n```\n- [/] unsupported';
 const q=createQueries({scan:()=>[{path:'tasks.md',content,revision:'r'}],read:()=>({}),parseNote});
 expect(q.tasks({status:'open'}).items.map(t=>t.text)).toEqual(['todo']);
 expect(q.tasks({status:'done'}).items[0]).toMatchObject({line:5,status:'done',sourceLine:'- [x] done',revision:'r'});
 expect(q.tasks({status:'all'}).total).toBe(2);
 expect(()=>q.tasks({status:'bad'})).toThrow();
});

it('counts each tag once per note and returns outgoing and candidate backlinks',()=>{
 expect(api.tags({}).items).toContainEqual({tag:'work/project',count:1});
 expect(api.links({path:'A.md'}).links[0].path).toBe('B');
 expect(api.backlinks({path:'B.md'}).items[0].path).toBe('A.md');
 expect(api.backlinks({path:'B.md',offset:1,limit:1}).items).toEqual([]);
 expect(api.backlinks({path:'B.md',offset:1,limit:1}).total).toBe(1);
});
