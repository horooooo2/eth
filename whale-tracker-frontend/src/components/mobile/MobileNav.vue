<script setup lang="ts">
defineProps<{tab:string;myOpen:boolean}>();
const emit=defineEmits<{select:[tab:'virtual'|'tradfi'|'my']}>();
const items=[{id:'virtual',label:'巨鲸',path:'M3 3v14h14M6 12l3-4 3 2 5-6'},{id:'tradfi',label:'研判',path:'M3 16V4h14v12zM6 12l3-4 3 2 3-4'},{id:'my',label:'我的',path:'M10 2a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7M3 18v-2a7 7 0 0 1 14 0v2'}] as const;
</script><template><nav class="h5-bottom" aria-label="手机主导航"><button v-for="item in items" :key="item.id" :class="{active:item.id==='my'?myOpen:!myOpen&&tab===item.id}" :aria-pressed="item.id==='my'?myOpen:!myOpen&&tab===item.id" @click="emit('select',item.id)"><svg viewBox="0 0 20 20" aria-hidden="true"><path :d="item.path"/></svg><span>{{item.label}}</span></button></nav></template>
