export type Inline = {type:'text'|'strong'|'code'|'link';text:string;url?:string};
export type ReplyBlock = {type:'paragraph'|'heading'|'list'|'quote'|'code';text?:string;items?:string[];ordered?:boolean};
export function safeReplyUrl(raw:string):string|undefined {
 try{const url=new URL(raw);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}
}
// Never interpret model output as HTML. Each token is rendered as a Vue text node.
export function replyInline(text:string):Inline[]{
 const out:Inline[]=[];const pattern=/\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)/g;
 let offset=0;
 for(const match of text.matchAll(pattern)){
  const index=match.index!;if(index>offset)out.push({type:'text',text:text.slice(offset,index)});
  if(match[1]||match[2])out.push({type:'strong',text:match[1]||match[2]});
  else if(match[3])out.push({type:'code',text:match[3]});
  else {const url=safeReplyUrl(match[5]);out.push({type:url?'link':'text',text:match[4],url});}
  offset=index+match[0].length;
 }
 if(offset<text.length)out.push({type:'text',text:text.slice(offset)});
 return out;
}
export function replyBlocks(raw:string):ReplyBlock[]{
 const lines=raw.replace(/\r\n?/g,'\n').split('\n'),blocks:ReplyBlock[]=[];
 let paragraph:string[]=[],code:string[]|null=null;
 const flush=()=>{if(paragraph.length){blocks.push({type:'paragraph',text:paragraph.join('\n')});paragraph=[];}};
 for(const line of lines){
  const text=line.trim();
  if(/^```/.test(text)){flush();if(code!==null){blocks.push({type:'code',text:code.join('\n')});code=null;}else code=[];continue;}
  if(code!==null){code.push(line);continue;}
  if(!text){flush();continue;}
  if(/^[-*_]{3,}$/.test(text)){flush();continue;}
  const heading=text.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
  // Common AI format: "- **历史链条**：正文" becomes a section, without rewriting facts.
  const labelled=text.match(/^(?:[-*+]\s+|\d+[.)、]\s*)?\*\*([^*\n]{1,36})\*\*\s*[：:]\s*(.*)$/);
  if(heading||labelled){flush();blocks.push({type:'heading',text:heading?heading[1]:labelled![1]});if(labelled?.[2])paragraph.push(labelled[2]);continue;}
  const list=text.match(/^(?:([-*+])\s+|\d+[.)、]\s+)(.+)$/);
  if(list){flush();const ordered=!list[1],last=blocks[blocks.length-1];if(last?.type==='list'&&last.ordered===ordered)last.items!.push(list[2]);else blocks.push({type:'list',items:[list[2]],ordered});continue;}
  if(/^>\s?/.test(text)){flush();blocks.push({type:'quote',text:text.replace(/^>\s?/, '')});continue;}
  paragraph.push(text);
 }
 flush();if(code!==null)blocks.push({type:'code',text:code.join('\n')});return blocks;
}
