"use strict";
/**
 * Meta Publisher Adapters
 * Instagram and Facebook Graph API publishers using official endpoints
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaOAuth = exports.FacebookPublisher = exports.InstagramPublisher = void 0;
exports.createInstagramPublisher = createInstagramPublisher;
exports.createFacebookPublisher = createFacebookPublisher;
exports.createMetaOAuth = createMetaOAuth;
/**
 * Instagram Publisher
 * Uses Instagram Graph API for official Reel publishing
 */
class InstagramPublisher {
    appId;
    appSecret;
    accessToken;
    baseUrl = 'https://graph.facebook.com/v18.0';
    constructor(appId, appSecret, accessToken) {
        this.appId = appId;
        this.appSecret = appSecret;
        this.accessToken = accessToken;
    }
    /**
     * Publish a Reel to Instagram
     * Official Meta API flow: 1) Create container, 2) Publish container
     */
    async publishReel(request) {
        try {
            // Step 1: Create media container
            const containerResponse = await fetch(`${this.baseUrl}/${request.accountId}/media`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    media_type: 'REELS',
                    video_url: request.videoUrl,
                    caption: this.buildCaption(request.caption, request.aiDisclosureRequired),
                    share_to_feed: request.shareToFeed !== false,
                    cover_url: request.coverUrl,
                    access_token: this.accessToken,
                }),
            });
            if (!containerResponse.ok) {
                const error = await containerResponse.json();
                throw new Error(`Failed to create IG container: ${JSON.stringify(error)}`);
            }
            const containerData = await containerResponse.json();
            const creationId = containerData.id;
            // Step 2: Poll until container is ready (max 60 seconds)
            await this.pollContainerStatus(creationId);
            // Step 3: Publish the container
            const publishResponse = await fetch(`${this.baseUrl}/${request.accountId}/media_publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    creation_id: creationId,
                    access_token: this.accessToken,
                }),
            });
            if (!publishResponse.ok) {
                const error = await publishResponse.json();
                throw new Error(`Failed to publish IG media: ${JSON.stringify(error)}`);
            }
            const publishData = await publishResponse.json();
            const mediaId = publishData.id;
            // Get permalink
            const permalink = await this.getPermalink(mediaId);
            return {
                mediaId,
                permalink,
                metadata: {
                    creationId,
                    mediaType: 'REELS',
                    publishedAt: new Date().toISOString(),
                },
            };
        }
        catch (error) {
            throw new Error(`Instagram publish failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Poll container status until ready
     */
    async pollContainerStatus(creationId, maxAttempts = 30) {
        for (let i = 0; i < maxAttempts; i++) {
            const response = await fetch(`${this.baseUrl}/${creationId}?fields=status_code,status&access_token=${this.accessToken}`);
            if (!response.ok) {
                throw new Error('Failed to check container status');
            }
            const data = await response.json();
            if (data.status_code === 'FINISHED') {
                return;
            }
            if (data.status_code === 'ERROR') {
                throw new Error(`Container processing failed: ${data.status}`);
            }
            // Wait 2 seconds before next poll
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error('Container processing timeout after 60 seconds');
    }
    /**
     * Get permalink for a published media
     */
    async getPermalink(mediaId) {
        try {
            const response = await fetch(`${this.baseUrl}/${mediaId}?fields=permalink&access_token=${this.accessToken}`);
            const data = await response.json();
            return data.permalink;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Build caption with AI disclosure if required
     */
    buildCaption(caption, aiRequired) {
        if (aiRequired) {
            return `${caption}\n\n🤖 AI-generated content`;
        }
        return caption;
    }
    /**
     * Get account insights
     */
    async getAccountInsights(mediaId) {
        try {
            const response = await fetch(`${this.baseUrl}/${mediaId}/insights?metric=impressions,reach,engagement,saves,shares&access_token=${this.accessToken}`);
            if (!response.ok) {
                throw new Error('Failed to fetch insights');
            }
            return await response.json();
        }
        catch (error) {
            console.error('Failed to get insights:', error);
            return null;
        }
    }
}
exports.InstagramPublisher = InstagramPublisher;
/**
 * Facebook Publisher
 * Uses Facebook Graph API for official Reel publishing to Pages
 */
class FacebookPublisher {
    appId;
    appSecret;
    accessToken;
    baseUrl = 'https://graph.facebook.com/v18.0';
    constructor(appId, appSecret, accessToken) {
        this.appId = appId;
        this.appSecret = appSecret;
        this.accessToken = accessToken;
    }
    /**
     * Publish a Reel to Facebook Page
     * Uses the official Page video upload flow
     */
    async publishReel(request) {
        try {
            // Upload video to Facebook
            const uploadResponse = await fetch(`${this.baseUrl}/${request.pageId}/video_reels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    upload_phase: 'start',
                    access_token: this.accessToken,
                }),
            });
            if (!uploadResponse.ok) {
                const error = await uploadResponse.json();
                throw new Error(`Failed to start FB upload: ${JSON.stringify(error)}`);
            }
            const uploadSession = await uploadResponse.json();
            const videoId = uploadSession.video_id;
            // Upload the video file
            // In production, this would use resumable upload
            const videoResponse = await fetch(request.videoUrl);
            const videoBuffer = await videoResponse.arrayBuffer();
            const finishResponse = await fetch(`${this.baseUrl}/${request.pageId}/video_reels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    upload_phase: 'finish',
                    upload_session_id: uploadSession.upload_session_id,
                    video_id: videoId,
                    access_token: this.accessToken,
                }),
            });
            if (!finishResponse.ok) {
                const error = await finishResponse.json();
                throw new Error(`Failed to finish FB upload: ${JSON.stringify(error)}`);
            }
            // Wait for video to be processed
            await this.pollVideoStatus(videoId);
            // Publish the video
            const publishResponse = await fetch(`${this.baseUrl}/${request.pageId}/video_reels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    video_id: videoId,
                    upload_phase: 'publish',
                    title: request.title,
                    description: request.description,
                    access_token: this.accessToken,
                }),
            });
            if (!publishResponse.ok) {
                const error = await publishResponse.json();
                throw new Error(`Failed to publish FB Reel: ${JSON.stringify(error)}`);
            }
            const publishData = await publishResponse.json();
            const postId = publishData.id;
            // Get permalink
            const permalink = await this.getPermalink(postId);
            return {
                postId,
                permalink,
                metadata: {
                    videoId,
                    publishedAt: new Date().toISOString(),
                },
            };
        }
        catch (error) {
            throw new Error(`Facebook publish failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Poll video status until published
     */
    async pollVideoStatus(videoId, maxAttempts = 30) {
        for (let i = 0; i < maxAttempts; i++) {
            const response = await fetch(`${this.baseUrl}/${videoId}?fields=status&access_token=${this.accessToken}`);
            if (!response.ok) {
                throw new Error('Failed to check video status');
            }
            const data = await response.json();
            if (data.status?.video_status === 'ready') {
                return;
            }
            if (data.status?.video_status === 'error') {
                throw new Error('Video processing failed');
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error('Video processing timeout');
    }
    /**
     * Get permalink
     */
    async getPermalink(postId) {
        try {
            const response = await fetch(`${this.baseUrl}/${postId}?fields=permalink_url&access_token=${this.accessToken}`);
            const data = await response.json();
            return data.permalink_url;
        }
        catch {
            return undefined;
        }
    }
}
exports.FacebookPublisher = FacebookPublisher;
/**
 * Meta OAuth Flow
 * Handles the official OAuth 2.0 flow for Meta platforms
 */
class MetaOAuth {
    appId;
    appSecret;
    redirectUri;
    baseUrl = 'https://graph.facebook.com/v18.0';
    dialogUrl = 'https://www.facebook.com/v18.0/dialog/oauth';
    constructor(appId, appSecret, redirectUri) {
        this.appId = appId;
        this.appSecret = appSecret;
        this.redirectUri = redirectUri;
    }
    /**
     * Generate OAuth URL for user to grant permissions
     */
    getAuthorizationUrl(state, scopes = [
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'instagram_basic',
        'instagram_content_publish',
        'instagram_manage_insights',
    ]) {
        const params = new URLSearchParams({
            client_id: this.appId,
            redirect_uri: this.redirectUri,
            state,
            scope: scopes.join(','),
            response_type: 'code',
        });
        return `${this.dialogUrl}?${params.toString()}`;
    }
    /**
     * Exchange authorization code for access token
     */
    async exchangeCodeForToken(code) {
        const params = new URLSearchParams({
            client_id: this.appId,
            client_secret: this.appSecret,
            redirect_uri: this.redirectUri,
            code,
        });
        const response = await fetch(`${this.baseUrl}/oauth/access_token?${params.toString()}`);
        if (!response.ok) {
            throw new Error('Failed to exchange code for token');
        }
        return await response.json();
    }
    /**
     * Exchange short-lived token for long-lived token (60 days)
     */
    async getLongLivedToken(shortLivedToken) {
        const params = new URLSearchParams({
            grant_type: 'fb_exchange_token',
            client_id: this.appId,
            client_secret: this.appSecret,
            fb_exchange_token: shortLivedToken,
        });
        const response = await fetch(`${this.baseUrl}/oauth/access_token?${params.toString()}`);
        if (!response.ok) {
            throw new Error('Failed to get long-lived token');
        }
        return await response.json();
    }
    /**
     * Get user's Facebook Pages
     */
    async getUserPages(accessToken) {
        const response = await fetch(`${this.baseUrl}/me/accounts?access_token=${accessToken}`);
        if (!response.ok) {
            throw new Error('Failed to fetch user pages');
        }
        const data = await response.json();
        return data.data || [];
    }
    /**
     * Get Instagram Business Account linked to a Page
     */
    async getInstagramAccount(pageId, accessToken) {
        const response = await fetch(`${this.baseUrl}/${pageId}?fields=instagram_business_account&access_token=${accessToken}`);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return data.instagram_business_account;
    }
}
exports.MetaOAuth = MetaOAuth;
// Factory functions
function createInstagramPublisher(appId, appSecret, accessToken) {
    return new InstagramPublisher(appId, appSecret, accessToken);
}
function createFacebookPublisher(appId, appSecret, accessToken) {
    return new FacebookPublisher(appId, appSecret, accessToken);
}
function createMetaOAuth(appId, appSecret, redirectUri) {
    return new MetaOAuth(appId, appSecret, redirectUri);
}
exports.default = {
    InstagramPublisher,
    FacebookPublisher,
    MetaOAuth,
    createInstagramPublisher,
    createFacebookPublisher,
    createMetaOAuth,
};
//# sourceMappingURL=meta-publisher.js.map