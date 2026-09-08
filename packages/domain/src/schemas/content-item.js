"use strict";
/**
 * ViralForge Content Item Schema
 * Unified schema for all 5 niches with multi-account, multi-niche support
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePayload = validatePayload;
// Helper to validate niche-specific payload
function validatePayload(nicheId, payload) {
    const errors = [];
    switch (nicheId) {
        case 'food':
            if (!payload.dish)
                errors.push("Food niche requires 'dish'");
            if (!payload.region)
                errors.push("Food niche requires 'region'");
            break;
        case 'health':
            if (!payload.originalDish)
                errors.push("Health niche requires 'originalDish'");
            if (!payload.transformedDish)
                errors.push("Health niche requires 'transformedDish'");
            break;
        case 'tech':
            if (!payload.toolName)
                errors.push("Tech niche requires 'toolName'");
            break;
        case 'edtech':
            if (!payload.exam)
                errors.push("EdTech niche requires 'exam'");
            break;
        case 'travel':
            if (!payload.location)
                errors.push("Travel niche requires 'location'");
            break;
        case 'cartoon':
            if (!payload.dialect)
                errors.push("Cartoon niche requires 'dialect'");
            break;
    }
    return errors;
}
//# sourceMappingURL=content-item.js.map