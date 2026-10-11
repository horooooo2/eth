<script lang="ts">
import {defineComponent,h,computed} from 'vue';
import {replyBlocks,replyInline} from '@/utils/aiReplyFormat';
export default defineComponent({name:'AiReply',props:{text:{type:String,required:true}},setup(props){
 const blocks=computed(()=>replyBlocks(props.text));
 const inline=(text:string)=>replyInline(text).map(token=>token.type==='strong'?h('strong',token.text):token.type==='code'?h('code',token.text):token.type==='link'?h('a',{href:token.url,target:'_blank',rel:'noopener noreferrer'},token.text):token.text);
 return()=>h('div',{class:'ai-reply'},blocks.value.map((block,index)=>{
  if(block.type==='list')return h(block.ordered?'ol':'ul',{key:index},block.items!.map((item,i)=>h('li',{key:i},inline(item))));
  if(block.type==='code')return h('pre',{key:index},[h('code',block.text)]);
  return h(block.type==='heading'?'h4':block.type==='quote'?'blockquote':'p',{key:index},inline(block.text||''));
 }));
}});
</script>
<style>
.ai-reply{font-size:14px;line-height:1.9;color:var(--text);overflow-wrap:anywhere;min-width:0}.ai-reply p{margin:0 0 14px;white-space:pre-wrap;color:#bdc6d3}.ai-reply>p:first-child{color:var(--text);font-size:15px}.ai-reply h4{display:flex;align-items:baseline;gap:9px;margin:22px 0 10px;font-size:14px;line-height:1.6;font-weight:600;color:var(--text)}.ai-reply h4:before{content:'';width:3px;height:12px;background:#efb563;flex:none;border-radius:2px}.ai-reply h4:first-child{margin-top:4px}.ai-reply strong{font-weight:600;color:#f0f2f6}.ai-reply ul,.ai-reply ol{padding-left:21px;margin:10px 0 16px}.ai-reply li{padding-left:3px;margin:8px 0;color:#bdc6d3}.ai-reply li::marker{color:#d7a765}.ai-reply a{color:#efb563;text-decoration:none;border-bottom:1px solid #efb56350;word-break:break-word}.ai-reply a:hover{border-bottom-color:#efb563}.ai-reply blockquote{border-left:2px solid #9c7444;margin:12px 0;padding:8px 12px;background:#efb56306;color:#aab6c7}.ai-reply code{font-family:Consolas,monospace;font-size:.92em;padding:2px 5px;background:#ffffff08;border-radius:4px}.ai-reply pre{overflow:auto;max-width:100%;padding:12px;background:#080c12;border:1px solid var(--border);border-radius:8px;white-space:pre-wrap}.ai-reply pre code{padding:0;background:none}.ai-reply>:last-child{margin-bottom:0}
</style>
