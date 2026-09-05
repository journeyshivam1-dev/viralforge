/**
 * ViralForge Content Item Schema
 * Unified schema for all 5 niches with multi-account, multi-niche support
 */

export type NicheId = 'food' | 'health' | 'tech' | 'edtech' | 'travel' | 'cartoon';

export type ContentStatus =
  | 'draft'
  | 'queued'
  | 'researched'
  | 'generated'
  | 'rendering'
  | 'validated'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type MediaType = 'video_reel' | 'image_carousel' | 'image_single';

export type TriggerSource = 'calendar' | 'telegram' | 'whatsapp' | 'manual' | 'omniroute';

export interface ContentItem {
  id: string;
  organizationId: string;
  nicheId: NicheId;
  nicheAccountId: string; // Links to connected Instagram/Facebook account
  subTopic: string; // Content pillar (e.g., "Quick Recipes", "Desk Job Health")
  dataInputPayload: Record<string, any>; // Niche-specific raw data
  hookVariationA: string; // High-retention opening
  scriptBody: string; // Full narrative or step-by-step breakdown
  visualReference?: string; // Stock asset tags, Google Earth KML, Midjourney seed URLs
  backgroundMusic?: string; // Licensed track ID from royalty-free library
  ctaDestination?: string; // Monetized link (affiliate, product, cohort signup)
  mediaType: MediaType;
  aiDisclosureRequired: boolean;
  status: ContentStatus;
  triggerSource: TriggerSource;
  triggerMetadata?: Record<string, any>; // Source-specific metadata
  scheduledAt?: Date; // When to publish
  publishedAt?: Date;
  metaPostId?: string; // Instagram Reel ID or Facebook Post ID
  insightsSnapshot?: Record<string, any>; // Reach, engagement, saves, shares
  validationErrors?: string[];
  validationWarnings?: string[];
  renderingManifest?: Record<string, any>; // Timings, layers, codec info
  aiGenerationMetadata?: Record<string, any>; // What was AI-generated, provider, model
  musicLicenseMetadata?: Record<string, any>; // Track ID, expires, attribution required
  createdAt: Date;
  updatedAt: Date;
  version: number; // For optimistic locking
}

export interface NicheProfile {
  id: string;
  organizationId: string;
  nicheId: NicheId;
  name: string; // Display name
  description?: string;
  brandLogoUrl: string; // Channel logo for this niche
  brandColors: Record<string, string>; // Primary, secondary, accent
  brandFonts: Record<string, string>; // Title, body, caption
  voiceoverPreference?: string; // TTS voice ID
  defaultMusicTrack?: string; // Default background music
  targetAudience?: string;
  contentPillars: string[]; // Array of pillar names
  promptTemplate: string; // Niche-specific LLM prompt
  maxPostsPerDay: number;
  autoPublishEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NicheAccount {
  id: string;
  organizationId: string;
  nicheId: NicheId;
  platform: 'instagram' | 'facebook';
  accountName: string;
  accountId: string; // Platform-specific account ID
  accountType: 'personal' | 'professional' | 'business';
  connectedAt: Date;
  tokenExpiresAt?: Date;
  status: 'active' | 'expired' | 'revoked' | 'pending';
  lastHealthCheck?: Date;
  metadata?: Record<string, any>;
}

export interface AuditLog {
  id: string;
  organizationId: string;
  nicheId?: NicheId;
  contentItemId?: string;
  jobId?: string;
  action: string; // e.g., "content_item.created", "job.started", "post.published"
  actor: string; // User ID or "system"
  actorType: 'user' | 'system' | 'webhook';
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
}

export interface Job {
  id: string;
  contentItemId: string;
  nicheId: NicheId;
  type: 'research' | 'generation' | 'media' | 'rendering' | 'validation' | 'publishing' | 'reconciliation';
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';
  attempts: number;
  maxAttempts: number;
  progress: number; // 0-100
  result?: Record<string, any>;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Niche-specific data input payloads
export interface FoodPayload {
  dish: string;
  region: string; // e.g., "Maharashtra", "Punjab"
  cookTime: number; // minutes
  difficulty: 'easy' | 'medium' | 'hard';
  ingredients: string[];
  steps: string[];
  cuisineType: string; // "Indian", "Street Food", "Home Style"
  dietaryTags?: string[]; // "vegetarian", "gluten-free", "vegan"
}

export interface HealthPayload {
  originalDish: string;
  transformedDish: string;
  calorieDelta: number;
  proteinTarget: number;
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  healthGoal: string; // "weight loss", "PCOS management", "diabetes"
  targetAudience: string; // "desk workers", "night shift"
}

export interface TechPayload {
  toolName: string;
  feature: string;
  painPoint: string;
  timeSaved: number; // hours
  targetAudience: string; // "freelancers", "corporate professionals"
  useCase: string;
}

export interface EdTechPayload {
  exam: string; // "JEE", "NEET", "UPSC"
  subject: string;
  topic: string;
  cheatCode: string; // Mnemonic or shortcut
  resourceLink: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface TravelPayload {
  location: string;
  baseCity: string;
  travelDuration: number; // hours
  budgetPerHead: number; // INR
  category: 'weekend_escape' | 'budget_tourism' | 'historical_trivia';
  season?: string;
}

export interface CartoonPayload {
  dialect: string; // "Mumbai Bambaiya", "Delhi vernacular"
  theme: string;
  characters: string[];
  comedicTwist: string;
  animationStyle: '2d' | '3d' | 'anime' | 'cinematic';
  culturalReference?: string; // "Panchatantra", "Tenali Rama"
}

// Helper to validate niche-specific payload
export function validatePayload(nicheId: NicheId, payload: Record<string, any>): string[] {
  const errors: string[] = [];

  switch (nicheId) {
    case 'food':
      if (!payload.dish) errors.push("Food niche requires 'dish'");
      if (!payload.region) errors.push("Food niche requires 'region'");
      break;
    case 'health':
      if (!payload.originalDish) errors.push("Health niche requires 'originalDish'");
      if (!payload.transformedDish) errors.push("Health niche requires 'transformedDish'");
      break;
    case 'tech':
      if (!payload.toolName) errors.push("Tech niche requires 'toolName'");
      break;
    case 'edtech':
      if (!payload.exam) errors.push("EdTech niche requires 'exam'");
      break;
    case 'travel':
      if (!payload.location) errors.push("Travel niche requires 'location'");
      break;
    case 'cartoon':
      if (!payload.dialect) errors.push("Cartoon niche requires 'dialect'");
      break;
  }

  return errors;
}