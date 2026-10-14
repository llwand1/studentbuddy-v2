import type { CampfireOpener } from './campfire-opener.js';
import type { VideoHit } from './video-route.js';

export interface LearningDirection {
  query: string;
  source: 'explicit' | 'focus' | 'exam' | 'practice' | 'video';
  reason: string;
}
export interface BilibiliLearningVideo {
  url: string;
  bvid: string;
  title: string;
  description: string;
  author: string;
  notes: string;
  selectedAt: number;
  informationSource?: 'public-api' | 'shared-page';
}
export interface BilibiliRecommendation {
  direction: LearningDirection;
  videos: VideoHit[];
  materials: Array<{ title: string; url: string; snippet: string }>;
  siteSearchUrl: string;
  note: string;
}
export interface BilibiliVideoQuiz {
  video: BilibiliLearningVideo;
  basis: 'notes' | 'shared-selection' | 'description';
  basisLabel: string;
  opener: CampfireOpener;
}
export const BILIBILI_NOTES_MAX = 12_000;
