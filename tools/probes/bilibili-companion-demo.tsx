import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionArt } from '../../packages/web/src/features/float/FloatCompanion';
import { BilibiliLearningCard } from '../../packages/web/src/features/plugins/BilibiliLearningCard';
import '../../packages/web/src/styles/tokens.css';
import '../../packages/web/src/features/plugins/plugins.css';
function Demo(){
  const [frame,setFrame]=useState(0);
  useEffect(()=>{const fn=(e:Event)=>setFrame((e as CustomEvent<number>).detail);window.addEventListener('demo-frame',fn);return()=>window.removeEventListener('demo-frame',fn);},[]);
  if(new URLSearchParams(location.search).get('kind')==='bili')return <div id="bili-demo"><small>实际组件 · 隔离预置视频与模型数据</small><BilibiliLearningCard plugin={{manifest:{schemaVersion:1,id:'bilibili',name:'B站学习',version:'1',description:'学习',transport:'builtin',endpoint:'https://www.bilibili.com/',tools:[]},builtin:true,policy:'bilibili_public_learning',enabled:true,hasToken:false,repositories:[],tools:[],testedAt:1,error:''}} onChange={async()=>{}}/></div>;
  const mood=frame<4?'preparing':frame<28?'question':frame<36?'celebrate':'encourage';
  return <main id="demo-canvas"><small>实际 Web 吉祥物 + Windows 原生邀请 · 隔离组件预览</small><h2>小题备好了，再邀请你挑战</h2>
    <div className="demo-mascot"><CompanionArt mood={mood}/></div>
    {frame>=4&&frame<28&&<img className="demo-native" src={'/native-frame/invite-'+String(Math.min(frame-4,23)).padStart(2,'0')+'.png'}/>}
    <p className="demo-state">{mood==='preparing'?'思考备题 · 符文聚合':mood==='question'?'待挑战 · 点击才打开题卡':mood==='celebrate'?'答对 · 星光庆祝': '答错 · 鼓励继续试'}</p>
    <footer>不抢焦点 · 不堆题 · 可延后 · 支持减少动态效果</footer></main>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
