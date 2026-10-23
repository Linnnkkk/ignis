import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const {inspectFile}=createRequire(import.meta.url)('./inspect');
it('inspects Canvas references without following them and attachments without returning bytes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-inspect-'));
 try {
  const file=path.join(root,'a.canvas');
  fs.writeFileSync(file,JSON.stringify({nodes:[{id:'a',type:'file',file:'../../secret'},{id:'b',type:'link',url:'http://internal'}],edges:[{fromNode:'a',toNode:'b'}]}));
  expect(inspectFile(file,'a.canvas').nodes[0].file).toBe('../../secret');
  const attachment=path.join(root,'a.pdf');fs.writeFileSync(attachment,'secret bytes');
  expect(inspectFile(attachment,'a.pdf').contentReturned).toBe(false);
  expect(()=>inspectFile(attachment,'a.exe')).toThrow();
  fs.writeFileSync(file,'invalid');expect(()=>inspectFile(file,'a.canvas')).toThrow();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
