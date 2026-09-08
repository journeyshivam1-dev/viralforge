/**
 * ViralForge Content Item Schema
 * Unified schema for all 5 niches with multi-account, multi-niche support
 */
export type NicheId = 'food' | 'health' | 'tech' | 'edtech' | 'travel' | 'cartoon';
export type ContentStatus = 'draft' | 'queued' | 'researched' | 'generated' | 'rendering' | 'validated' | 'scheduled' | 'publishing' | 'published' | 'blocked' | 'failed' | 'cancelled';
export type MediaType = 'video_reel' | 'image_carousel' | 'image_single';
export type TriggerSource = 'calendar' | 'telegram' | 'whatsapp' | 'manual' | 'omniroute';
export interface ContentItem {
    id: string;
    organizationId: string;
    nicheId: NicheId;
    nicheAccountId: string;
    subTopic: string;
    dataInputPayload: Record<string, any>;
    hookVariationA: string;
    scriptBody: string;
    visualReference?: string;
    backgroundMusic?: string;
    ctaDestination?: string;
    mediaType: MediaType;
    aiDisclosureRequired: boolean;
    status: ContentStatus;
    triggerSource: TriggerSource;
    triggerMetadata?: Record<string, any>;
    scheduledAt?: Date;
    publishedAt?: Date;
    metaPostId?: string;
    insightsSnapshot?: Record<string, any>;
    validationErrors?: string[];
    validationWarnings?: string[];
    renderingManifest?: Record<string, any>;
    aiGenerationMetadata?: Record<string, any>;
    musicLicenseMetadata?: Record<string, any>;
    createdAt: Date;
    updatedAt: Date;
    version: number;
}
export interface NicheProfile {
    id: string;
    organizationId: string;
    nicheId: NicheId;
    name: string;
    description?: string;
    brandLogoUrl: string;
    brandColors: Record<string, string>;
    brandFonts: Record<string, string>;
    voiceoverPreference?: string;
    defaultMusicTrack?: string;
    targetAudience?: string;
    contentPillars: string[];
    promptTemplate: string;
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
    accountId: string;
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
    action: string;
    actor: string;
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
    progress: number;
    result?: Record<string, any>;
    error?: string;
    startedAt?: Date;
    completedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
export interface FoodPayload {
    dish: string;
    region: string;
    cookTime: number;
    difficulty: 'easy' | 'medium' | 'hard';
    ingredients: string[];
    steps: string[];
    cuisineType: string;
    dietaryTags?: string[];
}
export interface HealthPayload {
    originalDish: string;
    transformedDish: string;
    calorieDelta: number;
    proteinTarget: number;
    mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
    healthGoal: string;
    targetAudience: string;
}
export interface TechPayload {
    toolName: string;
    feature: string;
    painPoint: string;
    timeSaved: number;
    targetAudience: string;
    useCase: string;
}
export interface EdTechPayload {
    exam: string;
    subject: string;
    topic: string;
    cheatCode: string;
    resourceLink: string;
    difficulty: 'easy' | 'medium' | 'hard';
}
export interface TravelPayload {
    location: string;
    baseCity: string;
    travelDuration: number;
    budgetPerHead: number;
    category: 'weekend_escape' | 'budget_tourism' | 'historical_trivia';
    season?: string;
}
export interface CartoonPayload {
    dialect: string;
    theme: string;
    characters: string[];
    comedicTwist: string;
    animationStyle: '2d' | '3d' | 'anime' | 'cinematic';
    culturalReference?: string;
}
export declare function validatePayload(nicheId: NicheId, payload: Record<string, any>): string[];
//# sourceMappingURL=content-item.d.ts.map