// Non-executing bounded inspection of Obsidian Canvas and attachment metadata.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ATTACHMENTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.pdf','.mp3','.wav','.m4a','.mp4','.webm']);
function inspectFile(absolute, relative) {
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Expected regular file'), {code:'FORBIDDEN'});
  const extension = path.extname(relative).toLowerCase();
  if (extension !== '.canvas' && !ATTACHMENTS.has(extension)) throw Object.assign(new Error('Unsupported attachment type'), {code:'FORBIDDEN'});
  if (extension !== '.canvas') return {path:relative,extension,bytes:stat.size,modifiedAt:stat.mtimeMs,contentReturned:false};
  if (stat.size > 1024 * 1024) throw Object.assign(new Error('Canvas exceeds 1 MiB limit'), {code:'LIMIT_EXCEEDED'});
  const content = fs.readFileSync(absolute,'utf8');
  let canvas;
  try {canvas=JSON.parse(content);} catch {throw Object.assign(new Error('Invalid Canvas JSON'),{code:'BAD_REQUEST'});}
  if (!canvas || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges) || canvas.nodes.length>1000 || canvas.edges.length>2000) throw Object.assign(new Error('Invalid or oversized Canvas graph'),{code:'BAD_REQUEST'});
  const nodes=canvas.nodes.map(n=>({id:typeof n?.id==='string'?n.id:'',type:typeof n?.type==='string'?n.type:'unknown',
    ...(typeof n?.text==='string'?{text:n.text}:{}),...(typeof n?.file==='string'?{file:n.file}:{}),...(typeof n?.url==='string'?{url:n.url}:{}),...(typeof n?.label==='string'?{label:n.label}:{})}));
  const edges=canvas.edges.map(e=>({fromNode:typeof e?.fromNode==='string'?e.fromNode:'',toNode:typeof e?.toNode==='string'?e.toNode:'',...(typeof e?.label==='string'?{label:e.label}:{})}));
  return {path:relative,bytes:stat.size,revision:crypto.createHash('sha256').update(content).digest('hex'),nodes,edges,warnings:['Read-only Canvas subset. Embedded files/URLs are references only; never fetched or executed.']};
}
module.exports={inspectFile};
