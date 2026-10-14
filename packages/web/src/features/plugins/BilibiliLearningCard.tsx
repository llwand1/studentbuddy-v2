import { useEffect, useState } from 'react';
import type { BilibiliLearningVideo, BilibiliRecommendation, BilibiliVideoQuiz, PluginView } from '@sb/shared';
import { pluginApi } from './plugin-api';
import { BrowserPicker } from '../desktop/BrowserPicker';
import { isLocalDesktopAddress } from '../desktop/desktop-api';
import { QuizCard } from '../quiz/QuizCard';

export function BilibiliLearningCard({ plugin, onChange }: { plugin: PluginView; onChange: () => Promise<void> }) {
  const [query,setQuery]=useState(''), [url,setUrl]=useState(''), [notes,setNotes]=useState('');
  const [video,setVideo]=useState<BilibiliLearningVideo|null>(null), [recommendation,setRecommendation]=useState<BilibiliRecommendation|null>(null);
  const [quiz,setQuiz]=useState<BilibiliVideoQuiz|null>(null), [busy,setBusy]=useState(false), [error,setError]=useState('');
  useEffect(()=>{
    let live=true;
    void pluginApi.bilibiliState().then(result=>{if(live){setVideo(result.video);setUrl(result.video?.url??'');setNotes(result.video?.notes??'');}})
      .catch(()=>{if(live)setError('视频学习状态暂时无法读取，可重试选择视频');});
    return()=>{live=false;};
  },[]);
  const run=async(work:()=>Promise<void>)=>{
    setBusy(true);setError('');
    try{await work();}catch(e){setError(e instanceof Error?e.message:'B站学习操作失败');}finally{setBusy(false);}
  };
  const enable=()=>run(async()=>{
    if(!isLocalDesktopAddress())window.open('https://www.bilibili.com/','_blank','noopener,noreferrer');
    await pluginApi.test('bilibili');await pluginApi.update('bilibili',{enabled:true});await onChange();
    if(isLocalDesktopAddress())await pluginApi.bilibiliOpen();
  });
  const select=async(address=url)=>{
    const next=await pluginApi.bilibiliUse<BilibiliLearningVideo>('select_video',{url:address});
    setVideo(next);setUrl(next.url);setNotes(next.notes);setQuiz(null);
  };
  return <article className="plugin-card bilibili-learning">
    <header><h4>B站学习</h4><span>{plugin.enabled?'已启用 · 公开学习模式':'未启用'}</span></header>
    <p>按你的学习方向找视频、资料和相关视频，依据实际材料练一题。无需 Token；不是账号授权，不读取观看历史。</p>
    {isLocalDesktopAddress()&&<BrowserPicker readerSetupHint={false}/>}
    <div className="plugin-actions">{!plugin.enabled?<button disabled={busy} onClick={()=>void enable()}>启用并打开 B站</button>:<>
      <button disabled={busy} onClick={()=>void run(async()=>{if(isLocalDesktopAddress())await pluginApi.bilibiliOpen();else window.open('https://www.bilibili.com/','_blank','noopener,noreferrer');})}>在浏览器打开 B站</button>
      <button disabled={busy} onClick={()=>void run(async()=>{await pluginApi.update('bilibili',{enabled:false});await onChange();})}>停用 B站学习</button>
      <button disabled={busy} onClick={()=>void run(async()=>{await pluginApi.disconnect('bilibili');setVideo(null);setNotes('');setUrl('');setQuiz(null);setRecommendation(null);await onChange();})}>清除视频学习记录</button>
    </>}</div>
    {plugin.enabled&&<>
      <label>学习方向（可留空，使用当前专注 / 应试 / 常学领域）<input aria-label="B站学习方向" value={query} maxLength={100} onChange={e=>setQuery(e.target.value)}/></label>
      <button disabled={busy} onClick={()=>void run(async()=>setRecommendation(await pluginApi.bilibiliUse<BilibiliRecommendation>('recommend_videos',query.trim()?{query}:{})))}>推荐视频与学习资料</button>
      {recommendation&&<section aria-label="B站学习推荐"><p>{recommendation.direction.query} · {recommendation.direction.reason}</p><small>{recommendation.note}</small>
        <ul>{recommendation.videos.map(hit=><li key={hit.url}><a href={hit.url} target="_blank" rel="noopener noreferrer">{hit.title}</a> <button disabled={busy} onClick={()=>void run(()=>select(hit.url))}>学习这个视频</button></li>)}</ul>
        {!recommendation.videos.length&&<p>这次没有找到视频，不补造链接。</p>}
        <a href={recommendation.siteSearchUrl} target="_blank" rel="noopener noreferrer">去 B站站内搜索</a>
        <h5>相关学习资料</h5><ul>{recommendation.materials.map(item=><li key={item.url}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a></li>)}</ul>
      </section>}
      <label>视频链接<input aria-label="B站视频链接" value={url} maxLength={1000} onChange={e=>{setUrl(e.target.value);setQuiz(null);}} placeholder="https://www.bilibili.com/video/BV…"/></label>
      <button disabled={busy||!url.trim()} onClick={()=>void run(()=>select())}>选择学习视频</button>
      {video&&<section aria-label="当前学习视频"><a href={video.url} target="_blank" rel="noopener noreferrer">{video.title}</a><p>{video.author}</p><p className="bilibili-description">{video.description}</p>
        <button disabled={busy} onClick={()=>void run(async()=>setRecommendation(await pluginApi.bilibiliUse<BilibiliRecommendation>('recommend_videos',{relatedToSelected:true})))}>推荐相关视频与资料</button>
        <label>字幕 / 学习笔记<textarea aria-label="B站字幕或学习笔记" value={notes} maxLength={12000} onChange={e=>{setNotes(e.target.value);setQuiz(null);}} rows={5}/></label>
        <small>只按真实读到的简介、同视频共读划选或你提交的笔记出题；没有完整讲解时不假装看完视频。可在桌面出题范围选择「B站学习视频」。</small>
        <button disabled={busy||url!==video.url} onClick={()=>void run(async()=>{setVideo(await pluginApi.bilibiliNotes(video.url,notes));setQuiz(await pluginApi.bilibiliUse<BilibiliVideoQuiz>('quiz_from_video',{}));})}>按这个视频练一题</button>
      </section>}
      {quiz&&<section aria-label="视频学习题"><p>出题依据：{quiz.basisLabel}</p><QuizCard quizId={'bilibili-'+quiz.opener.id} origin="chat" title={quiz.opener.question.topic}
        questions={[{type:'single',question:quiz.opener.question.question,options:quiz.opener.question.options,answer:[quiz.opener.question.answer],explanation:quiz.opener.question.explanation,material:quiz.opener.material}]}/></section>}
    </>}
    {busy&&<p role="status">正在处理 B站学习任务…</p>}{error&&<p className="plugin-error" role="alert">{error}</p>}
  </article>;
}
