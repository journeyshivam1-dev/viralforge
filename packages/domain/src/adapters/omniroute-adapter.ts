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
  callbackUrl?: string; // For async processing
}

interface OmnirouteResponse {
  id: string; // Job ID
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

export class OmnirouteAdapter {
  private config: OmnirouteConfig;

  constructor(config: OmnirouteConfig) {
    this.config = config;
  }

  /**
   * Generate content using Omniroute
   * @param request - The generation request
   * @returns Promise resolving to OmnirouteResponse
   */
  async generateContent(request: OmnirouteRequest): Promise<OmnirouteResponse> {
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

      return await response.json() as OmnirouteResponse;
    } catch (error) {
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
  async getJobStatus(jobId: string): Promise<OmnirouteResponse> {
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

      return await response.json() as OmnirouteResponse;
    } catch (error) {
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
  private getNicheOptimizations(niche: NicheId): Record<string, any> {
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
  async healthCheck(): Promise<boolean> {
    try {
      const url = new URL('/health', this.config.baseUrl);
      const response = await fetch(url.toString(), {
        timeout: 5000
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get available generation models/capabilities for a niche
   */
  async getCapabilities(niche: NicheId): Promise<Record<string, any>> {
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
    } catch {
      return {};
    }
  }
}

// Factory function for easy instantiation
export function createOmnirouteAdapter(
  baseUrl: string,
  apiKey: string,
  webhookSecret: string,
  timeoutMs = 300000
): OmnirouteAdapter {
  return new OmnirouteAdapter({
    baseUrl,
    apiKey,
    webhookSecret,
    timeoutMs
  });
}

export default OmnirouteAdapter;