import { Request, Response } from 'express';
import { supabase } from '@viralforge/supabase';

export const DEFAULT_ORG_EMAIL = 'local@viralforge.dev';
export const DEFAULT_ORG_NAME = 'ViralForge Local Studio';

export function sendError(res: Response, status: number, message: string, details?: unknown) {
  res.status(status).json({ ok: false, error: message, details });
}

export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error) => {
      console.error('[API] Route error:', error);
      sendError(res, 500, error instanceof Error ? error.message : 'Internal server error');
    });
  };
}

export async function ensureDefaultOrganization(): Promise<string> {
  const { data: existing, error: existingError } = await supabase
    .from('organizations')
    .select('id')
    .eq('email', DEFAULT_ORG_EMAIL)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to check default organization: ${existingError.message}`);
  }

  if (existing?.id) {
    return existing.id;
  }

  const { data, error } = await supabase
    .from('organizations')
    .insert({
      name: DEFAULT_ORG_NAME,
      email: DEFAULT_ORG_EMAIL,
      subscription_status: 'local',
      settings: {
        mode: 'local-dev',
        publishingDisabled: process.env.PUBLISHING_DISABLED !== 'false',
      },
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create default organization: ${error?.message || 'No data returned'}`);
  }

  return data.id;
}

export function parseLimit(value: unknown, fallback = 50): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 200);
}

export const SUPPORTED_NICHES = [
  {
    id: 'food',
    name: 'Food',
    description: 'Hindi regional recipes and home food stories',
    requiredFields: ['dish', 'region'],
    pillars: ['Quick ghar-ka-khana', 'Regional twist', 'Food story + recipe'],
  },
  {
    id: 'health',
    name: 'Health',
    description: 'Diet swaps and wellness content without medical claims',
    requiredFields: ['originalDish', 'transformedDish'],
    pillars: ['Healthy swap', 'Desk worker fitness', 'Simple meal prep'],
  },
  {
    id: 'tech',
    name: 'Tech',
    description: 'AI tools, productivity and creator workflows',
    requiredFields: ['toolName'],
    pillars: ['AI tools', 'Productivity', 'Freelancer growth'],
  },
  {
    id: 'edtech',
    name: 'EdTech',
    description: 'Exam tips, shortcuts and educational reels',
    requiredFields: ['exam'],
    pillars: ['Exam shortcut', 'Formula trick', 'Study plan'],
  },
  {
    id: 'travel',
    name: 'Travel',
    description: 'Budget travel, weekend escapes and hidden gems',
    requiredFields: ['location'],
    pillars: ['Weekend escape', 'Budget tourism', 'Historical trivia'],
  },
  {
    id: 'cartoon',
    name: 'Cartoon',
    description: 'Family-safe Hindi dialect comedy animation',
    requiredFields: ['dialect'],
    pillars: ['Family comedy', 'Dialect sketch', 'Cultural story'],
  },
] as const;
