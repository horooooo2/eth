<script setup lang="ts">
import type {SocketStatus} from '@/utils/socketStatus';
defineProps<{tab:string;myOpen:boolean;status:SocketStatus;title:string}>();
const emit=defineEmits<{select:[tab:'virtual'|'tradfi'|'news'|'my']}>();
const items=[{id:'virtual',label:'虚拟币',path:'M3 3v14h14M6 12l3-4 3 2 5-6'},{id:'tradfi',label:'雷达',path:'M10 2a8 8 0 1 0 8 8M10 6a4 4 0 1 0 4 4M10 10l7-7'},{id:'news',label:'新闻',path:'M3 2h14v16H3zM6 6h8M6 10h8M6 14h5'},{id:'my',label:'我的',path:'M10 2a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7M3 18v-2a7 7 0 0 1 14 0v2'}] as const;
</script><template><div class="h5-status" :title="title"><i :class="status"/><span>{{status==='connected'?'数据连接正常':status==='connecting'?'正在连接数据':'数据连接待恢复'}}</span></div><nav class="h5-bottom" aria-label="手机主导航"><button v-for="item in items" :key="item.id" :class="{active:item.id==='my'?myOpen:!myOpen&&tab===item.id}" :aria-pressed="item.id==='my'?myOpen:!myOpen&&tab===item.id" @click="emit('select',item.id)"><svg viewBox="0 0 20 20" aria-hidden="true"><path :d="item.path"/></svg><span>{{item.label}}</span></button></nav></template>
