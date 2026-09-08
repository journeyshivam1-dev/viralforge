"use strict";
/**
 * Omniroute Adapter for Content Generation
 * Uses your locally installed Omniroute for text, image, and video generation
 * This replaces direct Gemini API calls to avoid 429 errors
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OmnirouteAdapter = void 0;
exports.createOmnirouteAdapter = createOmnirouteAdapter;
class OmnirouteAdapter {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Generate content using Omniroute
     * @param request - The generation request
     * @returns Promise resolving to OmnirouteResponse
     */
    async generateContent(request) {
        try {
            const url = new URL('/api/v1/generate', this.config.baseUrl);
            const body = {
                ...request,
                apiKey: this.config.apiKey,
                timestamp: new Date().toISOString(),
                // Add niche-specific optimizations
                nicheOptimizations: this.getNicheOptimizations(request.niche)
            };
            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': this.config.webhookSecret
                },
                body: JSON.stringify(body),
                timeout: this.config.timeoutMs
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`Omniroute API error: ${errorData.message || response.statusText}`);
            }
            return await response.json();
        }
        catch (error) {
            return {
                id: `error-${Date.now()}`,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
        }
    }
    /**
     * Check the status of a generation job
     */
    async getJobStatus(jobId) {
        try {
            const url = new URL(`/api/v1/jobs/${jobId}`, this.config.baseUrl);
            const response = await fetch(url.toString(), {
                headers: {
                    'X-Webhook-Signature': this.config.webhookSecret
                }
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch job status: ${response.status}`);
            }
            return await response.json();
        }
        catch (error) {
            return {
                id: jobId,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
        }
    }
    /**
     * Get niche-specific optimizations for Omniroute
     * These help Omniroute generate better content for each niche
     */
    getNicheOptimizations(niche) {
        switch (niche) {
            case 'food':
                return {
                    language: 'hi-IN',
                    tone: 'friendly and accessible',
                    style: 'home cooking show',
                    avoid: ['complex techniques', 'unavailable ingredients'],
                    focusOn: ['visual appeal', 'simple steps', 'regional authenticity']
                };
            case 'health':
                return {
                    language: 'hi-IN',
                    tone: 'evidence-based and encouraging',
                    style: 'fitness coach',
                    avoid: ['medical claims', 'diagnosis', 'treatment promises'],
                    focusOn: ['measurable results', 'simple swaps', 'sustainable changes']
                };
            case 'tech':
                return {
                    language: 'hi-IN',
                    tone: 'energetic and growth-focused',
                    style: 'tech explainer',
                    avoid: ['jargon without explanation', 'false promises'],
                    focusOn: ['practical application', 'time savings', 'ease of use']
                };
            case 'edtech':
                return {
                    language: 'hi-IN',
                    tone: 'results-driven and urgent',
                    style: 'academic mentor',
                    avoid: ['oversimplification', 'missing context'],
                    focusOn: ['exam relevance', 'score improvement', 'time efficiency']
                };
            case 'travel':
                return {
                    language: 'hi-IN',
                    tone: 'curious and adventurous',
                    style: 'travel curator',
                    avoid: ['mainstream tourist traps', 'expensive recommendations'],
                    focusOn: ['hidden gems', 'budget options', 'local experiences']
                };
            case 'cartoon':
                return {
                    language: 'hi-IN',
                    tone: 'witty and family-friendly',
                    style: 'local comedy animator',
                    avoid: ['adult humor', 'offensive stereotypes'],
                    focusOn: ['relatable situations', 'clean humor', 'cultural references']
                };
            default:
                return {
                    language: 'hi-IN',
                    tone: 'neutral and informative'
                };
        }
    }
    /**
     * Check if Omniroute service is healthy
     */
    async healthCheck() {
        try {
            const url = new URL('/health', this.config.baseUrl);
            const response = await fetch(url.toString(), {
                timeout: 5000
            });
            return response.ok;
        }
        catch {
            return false;
        }
    }
    /**
     * Get available generation models/capabilities for a niche
     */
    async getCapabilities(niche) {
        try {
            const url = new URL(`/api/v1/capabilities/${niche}`, this.config.baseUrl);
            const response = await fetch(url.toString(), {
                headers: {
                    'X-Webhook-Signature': this.config.webhookSecret
                }
            });
            if (!response.ok) {
                return {};
            }
            return await response.json();
        }
        catch {
            return {};
        }
    }
}
exports.OmnirouteAdapter = OmnirouteAdapter;
// Factory function for easy instantiation
function createOmnirouteAdapter(baseUrl, apiKey, webhookSecret, timeoutMs = 300000) {
    return new OmnirouteAdapter({
        baseUrl,
        apiKey,
        webhookSecret,
        timeoutMs
    });
}
exports.default = OmnirouteAdapter;
//# sourceMappingURL=omniroute-adapter.js.map