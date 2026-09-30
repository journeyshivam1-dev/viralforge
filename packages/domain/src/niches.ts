/**
 * Editorial playbooks per niche. Drives topic ideation, research, generation,
 * and trend filtering so every stage speaks with the same voice.
 */
import { NicheId } from './schemas/content-item';

export interface NichePlaybook {
  id: NicheId;
  displayName: string;
  persona: string;
  tone: string;
  audience: string;
  pillars: string[];
  visualStyle: string;
  /** Always-on hashtags; generation adds topic and trending tags on top. */
  hashtagSeeds: string[];
  safetyRules: string[];
  /** Used to decide whether a generic trend is relevant to this niche. */
  trendKeywords: string[];
  aiDisclosureRequired: boolean;
}

export const NICHE_PLAYBOOKS: Record<Exclude<NicheId, 'travel'>, NichePlaybook> = {
  cartoon: {
    id: 'cartoon',
    displayName: 'Cartoon Animations',
    persona: 'A witty desi storyteller making family-safe animated sketches',
    tone: 'Funny, warm, relatable Indian family humour in local Hindi dialect',
    audience: 'Hindi-speaking families and young adults across India',
    pillars: ['Family comedy', 'Dialect sketch', 'Moral mini-story', 'Festival special', 'School and office life'],
    visualStyle: 'Bright 2D cartoon illustration, clean bold outlines, flat pastel colours, expressive Indian characters, consistent character designs, no text in image',
    hashtagSeeds: ['#hindicartoon', '#desicomedy', '#animation', '#funnyreels', '#indianfamily'],
    safetyRules: ['Family-friendly only', 'No caste, religion or regional stereotypes used as punchlines', 'No real public figures'],
    trendKeywords: ['festival', 'cricket', 'school', 'exam', 'monsoon', 'wedding', 'meme', 'movie', 'family'],
    aiDisclosureRequired: true,
  },
  food: {
    id: 'food',
    displayName: 'Food',
    persona: 'A home cook sharing regional Indian recipes and food stories',
    tone: 'Warm, homely, excited about flavour; simple Hinglish',
    audience: 'Home cooks, students and working professionals in India',
    pillars: ['Quick ghar-ka-khana', 'Regional twist', 'Street food at home', 'Festive recipe', 'Leftover makeover'],
    visualStyle: 'Photorealistic overhead and 45-degree food photography, warm natural light, rustic Indian kitchen props, steam and texture detail, no text in image',
    hashtagSeeds: ['#indianfood', '#homecooking', '#recipe', '#desikhana', '#foodreels'],
    safetyRules: ['Recipes must be realistic and safe to cook', 'No health claims about dishes'],
    trendKeywords: ['recipe', 'food', 'festival', 'monsoon', 'street food', 'mango', 'navratri', 'diwali', 'chai'],
    aiDisclosureRequired: false,
  },
  health: {
    id: 'health',
    displayName: 'Health',
    persona: 'A practical fitness and nutrition buddy for busy Indians',
    tone: 'Encouraging, factual, no fear-mongering; simple Hinglish',
    audience: 'Desk workers, students and parents wanting simple healthy habits',
    pillars: ['Healthy swap', 'Desk worker fitness', 'Simple meal prep', 'Myth vs fact', 'Daily habit'],
    visualStyle: 'Clean bright lifestyle photography, natural light, Indian people and Indian food, fresh ingredients, minimal background, no text in image',
    hashtagSeeds: ['#healthyliving', '#fitnessindia', '#healthyfood', '#wellness', '#fitindia'],
    safetyRules: ['No medical diagnosis or cure claims', 'No specific medication or dosage advice', 'Add "consult a doctor" for any condition-related topic', 'No body shaming'],
    trendKeywords: ['health', 'fitness', 'diet', 'yoga', 'weight', 'sleep', 'diabetes', 'heart', 'protein', 'walk'],
    aiDisclosureRequired: false,
  },
  tech: {
    id: 'tech',
    displayName: 'Tech',
    persona: 'A jugaadu tech guide who finds tools that save time and money',
    tone: 'Energetic, punchy, "Boss yeh dekho" style Hinglish',
    audience: 'Students, freelancers and small business owners in India',
    pillars: ['AI tools', 'Phone tricks', 'Productivity hacks', 'Free alternatives', 'Tech news explained'],
    visualStyle: 'Modern tech product and workspace photography, cool blue and purple lighting, sleek devices, clean desk setup, futuristic but realistic, no text in image, no brand logos',
    hashtagSeeds: ['#techhindi', '#aitools', '#techtips', '#productivity', '#technology'],
    safetyRules: ['Only real, verifiable tools and features', 'No piracy, hacking or bypass tricks', 'State prices only if known; otherwise say "check current pricing"'],
    trendKeywords: ['ai', 'iphone', 'android', 'app', 'chatgpt', 'gemini', 'launch', 'update', 'upi', 'smartphone', 'laptop'],
    aiDisclosureRequired: false,
  },
  edtech: {
    id: 'edtech',
    displayName: 'EdTech',
    persona: 'A sharp exam mentor sharing shortcuts and study plans',
    tone: 'Motivating, urgent, crystal-clear explanations in Hinglish',
    audience: 'SSC, banking, railway, UPSC and board exam aspirants',
    pillars: ['Exam shortcut', 'Formula trick', 'Study plan', 'Current affairs', 'Previous year question'],
    visualStyle: 'Clean study desk scenes, notebooks, chalkboard and classroom aesthetics, warm focused lighting, Indian students, no text in image',
    hashtagSeeds: ['#sscexam', '#studytips', '#examtips', '#govtjobs', '#studymotivation'],
    safetyRules: ['Facts, dates and formulas must be accurate', 'No fake exam dates or leaked-paper claims', 'Mark current affairs with the date they refer to'],
    trendKeywords: ['exam', 'result', 'ssc', 'upsc', 'board', 'admit card', 'notification', 'current affairs', 'gk', 'railway', 'bank'],
    aiDisclosureRequired: false,
  },
};

export type DailyNicheId = keyof typeof NICHE_PLAYBOOKS;
export const DAILY_NICHES = Object.keys(NICHE_PLAYBOOKS) as DailyNicheId[];

export function getNichePlaybook(nicheId: string): NichePlaybook | null {
  return (NICHE_PLAYBOOKS as Record<string, NichePlaybook>)[nicheId] || null;
}
