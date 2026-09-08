/**
 * Omniroute Adapter for Content Generation
 * Uses your locally installed Omniroute for text, image, and video generation
 * This replaces direct Gemini API calls to avoid 429 errors
 */
import { NicheId } from '../schemas/content-item';
interface OmnirouteConfig {
    baseUrl: string;
    apiKey: string;
    webhookSecret: string;
    timeoutMs: number;
}
interface OmnirouteRequest {
    type: 'text' | 'image' | 'video';
    prompt: string;
    niche: NicheId;
    parameters?: Record<string, any>;
    callbackUrl?: string;
}
interface OmnirouteResponse {
    id: string;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    result?: {
        text?: string;
        imageUrl?: string;
        videoUrl?: string;
        metadata?: Record<string, any>;
    };
    error?: string;
    createdAt: string;
    updatedAt: string;
}
export declare class OmnirouteAdapter {
    private config;
    constructor(config: OmnirouteConfig);
    /**
     * Generate content using Omniroute
     * @param request - The generation request
     * @returns Promise resolving to OmnirouteResponse
     */
    generateContent(request: OmnirouteRequest): Promise<OmnirouteResponse>;
    /**
     * Check the status of a generation job
     */
    getJobStatus(jobId: string): Promise<OmnirouteResponse>;
    /**
     * Get niche-specific optimizations for Omniroute
     * These help Omniroute generate better content for each niche
     */
    private getNicheOptimizations;
    /**
     * Check if Omniroute service is healthy
     */
    healthCheck(): Promise<boolean>;
    /**
     * Get available generation models/capabilities for a niche
     */
    getCapabilities(niche: NicheId): Promise<Record<string, any>>;
}
export declare function createOmnirouteAdapter(baseUrl: string, apiKey: string, webhookSecret: string, timeoutMs?: number): OmnirouteAdapter;
export default OmnirouteAdapter;
//# sourceMappingURL=omniroute-adapter.d.ts.map