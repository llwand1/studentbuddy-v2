import { useEffect, useState } from 'react';
import type { CampfireOpener } from '@sb/shared';
import { hasHost, postToHost } from './float-view';
import './companion-invitation.css';
export const HOST_INVITE = 'sb-float:invite:';
export const HOST_CHALLENGE = 'sb-float:challenge:';
export const HOST_SNOOZE = 'sb-float:snooze:';
export function CompanionInvitation({ opener, onChallenge, onSnooze }: { opener: CampfireOpener; onChallenge: () => void; onSnooze: () => void }) {
  const [reduced,setReduced]=useState(()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches??false);
  useEffect(()=>{
    const media=window.matchMedia?.('(prefers-reduced-motion: reduce)'), change=()=>setReduced(media?.matches??false);
    media?.addEventListener('change',change);return()=>media?.removeEventListener('change',change);
  },[]);
  useEffect(()=>{
    if(hasHost())postToHost(HOST_INVITE+JSON.stringify({id:opener.id,topic:opener.question.topic,reducedMotion:reduced}));
  },[opener.id,opener.question.topic,reduced]);
  useEffect(()=>()=>{if(hasHost())postToHost(HOST_INVITE+'off');},[]);
  if(hasHost())return null;
  const caption=`${opener.question.topic}的小题出好了，快来挑战一下吧！`;
  return <aside className="sb-companion-invitation" aria-label="吉祥物练习邀请">
    <span className="sb-invite-runes" aria-hidden="true">✦ ◇ ϟ ✧</span><small>✦ 学习来信</small>
    <p aria-live="polite">{reduced?caption:<><span className="sb-invite-readable">{caption}</span><span aria-hidden="true">{Array.from(caption).map((char,index)=><span key={index} className={'sb-invite-char sb-invite-phase-'+Math.min(index,15)}>{char}</span>)}</span></>}</p>
    <div><button onClick={onChallenge}>挑战一下</button><button onClick={onSnooze}>两分钟后</button></div>
  </aside>;
}
