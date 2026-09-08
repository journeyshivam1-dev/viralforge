/**
 * Meta Publisher Adapters
 * Instagram and Facebook Graph API publishers using official endpoints
 */
interface PublishReelInstagramRequest {
    accountId: string;
    videoUrl: string;
    caption: string;
    aiDisclosureRequired: boolean;
    coverUrl?: string;
    shareToFeed?: boolean;
}
interface PublishReelFacebookRequest {
    pageId: string;
    videoUrl: string;
    title: string;
    description: string;
}
interface InstagramPublishResult {
    mediaId: string;
    permalink?: string;
    metadata: Record<string, any>;
}
interface FacebookPublishResult {
    postId: string;
    permalink?: string;
    metadata: Record<string, any>;
}
/**
 * Instagram Publisher
 * Uses Instagram Graph API for official Reel publishing
 */
export declare class InstagramPublisher {
    private appId;
    private appSecret;
    private accessToken;
    private baseUrl;
    constructor(appId: string, appSecret: string, accessToken: string);
    /**
     * Publish a Reel to Instagram
     * Official Meta API flow: 1) Create container, 2) Publish container
     */
    publishReel(request: PublishReelInstagramRequest): Promise<InstagramPublishResult>;
    /**
     * Poll container status until ready
     */
    private pollContainerStatus;
    /**
     * Get permalink for a published media
     */
    private getPermalink;
    /**
     * Build caption with AI disclosure if required
     */
    private buildCaption;
    /**
     * Get account insights
     */
    getAccountInsights(mediaId: string): Promise<any>;
}
/**
 * Facebook Publisher
 * Uses Facebook Graph API for official Reel publishing to Pages
 */
export declare class FacebookPublisher {
    private appId;
    private appSecret;
    private accessToken;
    private baseUrl;
    constructor(appId: string, appSecret: string, accessToken: string);
    /**
     * Publish a Reel to Facebook Page
     * Uses the official Page video upload flow
     */
    publishReel(request: PublishReelFacebookRequest): Promise<FacebookPublishResult>;
    /**
     * Poll video status until published
     */
    private pollVideoStatus;
    /**
     * Get permalink
     */
    private getPermalink;
}
/**
 * Meta OAuth Flow
 * Handles the official OAuth 2.0 flow for Meta platforms
 */
export declare class MetaOAuth {
    private appId;
    private appSecret;
    private redirectUri;
    private baseUrl;
    private dialogUrl;
    constructor(appId: string, appSecret: string, redirectUri: string);
    /**
     * Generate OAuth URL for user to grant permissions
     */
    getAuthorizationUrl(state: string, scopes?: string[]): string;
    /**
     * Exchange authorization code for access token
     */
    exchangeCodeForToken(code: string): Promise<{
        accessToken: string;
        expiresIn: number;
    }>;
    /**
     * Exchange short-lived token for long-lived token (60 days)
     */
    getLongLivedToken(shortLivedToken: string): Promise<{
        accessToken: string;
        expiresIn: number;
    }>;
    /**
     * Get user's Facebook Pages
     */
    getUserPages(accessToken: string): Promise<any[]>;
    /**
     * Get Instagram Business Account linked to a Page
     */
    getInstagramAccount(pageId: string, accessToken: string): Promise<any | null>;
}
export declare function createInstagramPublisher(appId: string, appSecret: string, accessToken: string): InstagramPublisher;
export declare function createFacebookPublisher(appId: string, appSecret: string, accessToken: string): FacebookPublisher;
export declare function createMetaOAuth(appId: string, appSecret: string, redirectUri: string): MetaOAuth;
declare const _default: {
    InstagramPublisher: typeof InstagramPublisher;
    FacebookPublisher: typeof FacebookPublisher;
    MetaOAuth: typeof MetaOAuth;
    createInstagramPublisher: typeof createInstagramPublisher;
    createFacebookPublisher: typeof createFacebookPublisher;
    createMetaOAuth: typeof createMetaOAuth;
};
export default _default;
//# sourceMappingURL=meta-publisher.d.ts.map