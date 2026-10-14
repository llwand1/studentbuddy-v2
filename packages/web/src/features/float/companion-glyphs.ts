import type { ClipRect, CompanionMood } from './companion-view';
/** Tiny code-native glyphs; the same pixels join the native clip, never a clipped font overlay. */
const FONT: Record<string,string[]> = {
  '?':['110','001','010','000','010'], '!':['010','010','010','000','010'],
  '+':['000','010','111','010','000'], 'λ':['100','010','010','101','101'],
  'Σ':['111','100','010','100','111'], 'π':['111','101','101','101','101'],
};
export function companionGlyphs(mood:CompanionMood,tick:number):Array<{char:string;rects:ClipRect[]}> {
  const chars=mood==='question'?['?','!','?','!']:mood==='celebrate'?['!','+','!','+']
    :mood==='encourage'?['+','π']:['preparing','retrieving','play'].includes(mood)?['λ','Σ','π','?']:[];
  return chars.map((char,index)=>{
    const angle=index*Math.PI*2/chars.length+tick*.025;
    const x=Math.round(30+Math.cos(angle)*25),y=Math.round(27+Math.sin(angle)*23);
    const rects:ClipRect[]=[];
    FONT[char]?.forEach((row,dy)=>Array.from(row).forEach((cell,dx)=>{if(cell==='1')rects.push([x+dx,y+dy,1,1]);}));
    return {char,rects};
  });
}
