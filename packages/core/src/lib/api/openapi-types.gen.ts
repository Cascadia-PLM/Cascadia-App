// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * GENERATED FILE — do not edit.
 *
 * Derived from docs/api/openapi.v1.json (community view) by
 * scripts/generate-api-types.mjs. Regenerate with `npm run types:openapi`;
 * CI fails on drift via `npm run types:openapi:check`.
 *
 * Coverage note: the snapshot documents success-response schemas on a
 * minority of operations, so most `paths` entries carry only error
 * envelopes for now. As the API workstream annotates `responses` on more
 * routes, their types appear here on the next regeneration — consume them
 * via the helpers in ./typed.ts.
 */

export interface paths {
    "/api/v1/admin/ai-settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminAiSettings"];
        put?: never;
        post: operations["postApiV1AdminAiSettings"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/ai-settings/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * List models available from an AI provider
         * @description Queries the provider’s own list-models endpoint. Falls back to the stored settings key, then the environment key, when no plaintext key is supplied. Returns 503 if the provider is unreachable or rejects the key.
         */
        post: operations["postApiV1AdminAiSettingsModels"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/ai-settings/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminAiSettingsTest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/api-key-policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminApiKeyPolicy"];
        put: operations["putApiV1AdminApiKeyPolicy"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/api-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminApiKeys"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/api-keys/{keyId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteApiV1AdminApiKeysByKeyId"];
        options?: never;
        head?: never;
        patch: operations["patchApiV1AdminApiKeysByKeyId"];
        trace?: never;
    };
    "/api/v1/admin/api-keys/{keyId}/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminApiKeysByKeyIdActivity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/api-keys/{keyId}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminApiKeysByKeyIdDisable"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/api-keys/{keyId}/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminApiKeysByKeyIdEnable"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/component-catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminComponentCatalog"];
        put?: never;
        post: operations["postApiV1AdminComponentCatalog"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/component-catalog/categories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminComponentCatalogCategories"];
        put?: never;
        post: operations["postApiV1AdminComponentCatalogCategories"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/component-catalog/categories/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putApiV1AdminComponentCatalogCategoriesById"];
        post?: never;
        delete: operations["deleteApiV1AdminComponentCatalogCategoriesById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/component-catalog/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminComponentCatalogImport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/component-catalog/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminComponentCatalogById"];
        put: operations["putApiV1AdminComponentCatalogById"];
        post?: never;
        delete: operations["deleteApiV1AdminComponentCatalogById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/item-type-configs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminItemTypeConfigs"];
        put?: never;
        post: operations["postApiV1AdminItemTypeConfigs"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/item-type-configs/{itemType}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminItemTypeConfigsByItemType"];
        put?: never;
        post?: never;
        delete: operations["deleteApiV1AdminItemTypeConfigsByItemType"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminJobsById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/jobs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminJobsByIdCancel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/jobs/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminJobsByIdRetry"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/reload-config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminReloadConfig"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminSettings"];
        put?: never;
        post: operations["postApiV1AdminSettings"];
        delete: operations["deleteApiV1AdminSettings"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/thread-cache/cleanup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminThreadCacheCleanup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/thread-cache/clear": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminThreadCacheClear"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/thread-cache/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminThreadCacheStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/thread-cache/warm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AdminThreadCacheWarm"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/vault-config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AdminVaultConfig"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/chat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AiChat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AiSessions"];
        put?: never;
        post: operations["postApiV1AiSessions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AiSessionsById"];
        put?: never;
        post?: never;
        delete: operations["deleteApiV1AiSessionsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/sessions/{id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AiSessionsByIdMessages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ai/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AiSettings"];
        put: operations["putApiV1AiSettings"];
        post: operations["postApiV1AiSettings"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/api-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AuthApiKeys"];
        put?: never;
        post: operations["postApiV1AuthApiKeys"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/api-keys/{keyId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteApiV1AuthApiKeysByKeyId"];
        options?: never;
        head?: never;
        patch: operations["patchApiV1AuthApiKeysByKeyId"];
        trace?: never;
    };
    "/api/v1/auth/api-keys/{keyId}/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AuthApiKeysByKeyIdActivity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/api-keys/{keyId}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AuthApiKeysByKeyIdDisable"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/api-keys/{keyId}/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AuthApiKeysByKeyIdEnable"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/api-keys/{keyId}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AuthApiKeysByKeyIdRotate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/callback/github": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AuthCallbackGithub"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/github": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AuthGithub"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AuthLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1AuthLogout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putApiV1AuthPassword"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/permissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AuthPermissions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1AuthSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/branch-items/{id}/pull-from-main": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1BranchItemsByIdPullFromMain"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/branch-items/{id}/rebase": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1BranchItemsByIdRebase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/branches/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1BranchesById"];
        put: operations["putApiV1BranchesById"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/branches/{id}/commits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1BranchesByIdCommits"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/branches/{id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1BranchesByIdItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/branches/{id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1BranchesByIdStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrders"];
        put?: never;
        /** Create a change order against one or more designs */
        post: operations["postApiV1ChangeOrders"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/editable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersEditable"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersById"];
        put: operations["putApiV1ChangeOrdersById"];
        post?: never;
        delete: operations["deleteApiV1ChangeOrdersById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/affected-items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdAffectedItems"];
        put?: never;
        /** Add one or more affected items to a change order */
        post: operations["postApiV1ChangeOrdersByIdAffectedItems"];
        delete: operations["deleteApiV1ChangeOrdersByIdAffectedItems"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/affected-items/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Preview the change actions available for items */
        post: operations["postApiV1ChangeOrdersByIdAffectedItemsPreview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/approvals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdApprovals"];
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdApprovals"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/approvals/can-approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdApprovalsCanApprove"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/approvals/{stateId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdApprovalsByStateId"];
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdApprovalsByStateId"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/bom-changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdBomChanges"];
        delete: operations["deleteApiV1ChangeOrdersByIdBomChanges"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/branch-history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdBranchHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/branch-history/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdBranchHistoryGraph"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdCheckout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/conflict-reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdConflictReviews"];
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdConflictReviews"];
        delete: operations["deleteApiV1ChangeOrdersByIdConflictReviews"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/conflicts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdConflicts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/designs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdDesigns"];
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdDesigns"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/designs/{designId}/structure": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdDesignsByDesignIdStructure"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/impact-assessment": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdImpactAssessment"];
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdImpactAssessment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/items/{itemId}/ancestors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdItemsByItemIdAncestors"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdRelease"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/resolve-conflicts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdResolveConflicts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/risks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdRisks"];
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdRisks"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/workflow": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdWorkflow"];
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdWorkflow"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/workflow/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdWorkflowHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/workflow/states/{stateId}/approvers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdWorkflowStatesByStateIdApprovers"];
        put: operations["putApiV1ChangeOrdersByIdWorkflowStatesByStateIdApprovers"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/workflow/structure": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdWorkflowStructure"];
        put: operations["putApiV1ChangeOrdersByIdWorkflowStructure"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/workflow/transition": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ChangeOrdersByIdWorkflowTransition"];
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdWorkflowTransition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/change-orders/{id}/workflow/validate-transition": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ChangeOrdersByIdWorkflowValidateTransition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/commits/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1CommitsById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/commits/{id}/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1CommitsByIdDiff"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/commits/{id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1CommitsByIdItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/dashboard/charts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DashboardCharts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/dashboard/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DashboardStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Designs"];
        put?: never;
        /**
         * Create a design
         * @description With `programId`, the caller needs the `canManageDesigns` flag on their membership of that program (or cross-program authority). Without one, the global `designs:create` permission. Creating a design also creates its `main` branch and initial commit.
         */
        post: operations["postApiV1Designs"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/families": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsFamilies"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{designId}/gap-analysis": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByDesignIdGapAnalysis"];
        put?: never;
        post: operations["postApiV1DesignsByDesignIdGapAnalysis"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{designId}/requirements-coverage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByDesignIdRequirementsCoverage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{designId}/test-coverage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByDesignIdTestCoverage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{designId}/verification-gaps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByDesignIdVerificationGaps"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsById"];
        put: operations["putApiV1DesignsById"];
        post?: never;
        delete: operations["deleteApiV1DesignsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/branches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdBranches"];
        put?: never;
        post: operations["postApiV1DesignsByIdBranches"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/clone": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1DesignsByIdClone"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/cross-references": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdCrossReferences"];
        put: operations["putApiV1DesignsByIdCrossReferences"];
        post: operations["postApiV1DesignsByIdCrossReferences"];
        delete: operations["deleteApiV1DesignsByIdCrossReferences"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/details": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdDetails"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/ecos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdEcos"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the scope graph for a design
         * @description Returns the design as a graph node, its parent program above it, and the top-level items it contains below it. Filter contained items with itemTypes (comma-separated); nested items are expanded per-node via the item graph endpoint.
         */
        get: operations["getApiV1DesignsByIdGraph"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/history/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdHistoryGraph"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdItems"];
        put?: never;
        post: operations["postApiV1DesignsByIdItems"];
        delete: operations["deleteApiV1DesignsByIdItems"];
        options?: never;
        head?: never;
        patch: operations["patchApiV1DesignsByIdItems"];
        trace?: never;
    };
    "/api/v1/designs/{id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdMembers"];
        put?: never;
        post: operations["postApiV1DesignsByIdMembers"];
        delete: operations["deleteApiV1DesignsByIdMembers"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/structure": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdStructure"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/designs/{id}/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DesignsByIdTags"];
        put?: never;
        post: operations["postApiV1DesignsByIdTags"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/documents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1DocumentsById"];
        put: operations["putApiV1DocumentsById"];
        post?: never;
        delete: operations["deleteApiV1DocumentsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/enterprise-search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1EnterpriseSearch"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/enterprise-search/results": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search all item types with paging, sorting and filters
         * @description Flat, paged search across every item type the user may read, scoped to designs in their programs plus library designs. Sortable and filterable on base item columns; `program` and `design` column filters take ids. Rows carry the full base item record plus design and program identity.
         */
        get: operations["getApiV1EnterpriseSearchResults"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Files"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/batch-checkin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1FilesBatchCheckin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/batch-checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1FilesBatchCheckout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteApiV1FilesByFileId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/annotations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List a file's markup */
        get: operations["getApiV1FilesByFileIdAnnotations"];
        put?: never;
        /**
         * Add markup to a file
         * @description Requires the owning item to be checked out to the caller. Responds 409 when it is not, or is checked out by somebody else.
         */
        post: operations["postApiV1FilesByFileIdAnnotations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/annotations/{annotationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove markup */
        delete: operations["deleteApiV1FilesByFileIdAnnotationsByAnnotationId"];
        options?: never;
        head?: never;
        /** Revise markup (author only) */
        patch: operations["patchApiV1FilesByFileIdAnnotationsByAnnotationId"];
        trace?: never;
    };
    "/api/v1/files/{fileId}/category": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Set or clear a file's category
         * @description Categories are guessed from the filename at upload. Send a category to record a person's answer instead — it is marked manual and nothing re-detects over it, including a new version uploaded on check-in. Send null to clear the override and fall back to auto-detection.
         */
        patch: operations["patchApiV1FilesByFileIdCategory"];
        trace?: never;
    };
    "/api/v1/files/{fileId}/checkin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1FilesByFileIdCheckin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1FilesByFileIdCheckout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream a file inline for in-app preview
         * @description Serves the file for rendering in the embedded viewer. Only formats Cascadia can display are served (PDF, raster images, SVG, plain text) and only up to the preview size ceiling for that format; anything else must be downloaded. Logs a `view` action rather than a `download`.
         */
        get: operations["getApiV1FilesByFileIdContent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/convert": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Queue a CAD file for mesh conversion
         * @description STEP (.step/.stp) and IGES (.iges/.igs) only. Returns 202 with the id of a background job — poll GET /api/v1/jobs/:id for its result; the STL and GLB appear as new files on the target item when it completes. The body is optional: an absent or unparseable one runs on the defaults below.
         */
        post: operations["postApiV1FilesByFileIdConvert"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1FilesByFileIdDownload"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/force-unlock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Release a file checkout lock held by another user
         * @description Requires documents:update, plus system:manage when the lock belongs to someone else. Releasing a lock you hold yourself is an ordinary check-in and needs no override.
         */
        post: operations["postApiV1FilesByFileIdForceUnlock"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/lock-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1FilesByFileIdLockStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/metadata": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1FilesByFileIdMetadata"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/thumbnail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1FilesByFileIdThumbnail"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1FilesByFileIdVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/versions/{version}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1FilesByFileIdVersionsByVersionDownload"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/files/{fileId}/watermark": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Queue a watermark stamp for a PDF attachment */
        post: operations["postApiV1FilesByFileIdWatermark"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/import/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ImportDocuments"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/import/issues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ImportIssues"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/import/parts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ImportParts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/import/templates/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ImportTemplatesDocuments"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/import/templates/issues": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ImportTemplatesIssues"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/import/templates/parts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ImportTemplatesParts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/issues/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1IssuesById"];
        put: operations["putApiV1IssuesById"];
        post?: never;
        delete: operations["deleteApiV1IssuesById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Items"];
        put?: never;
        /**
         * Create an item of any type
         * @description The body is the item type’s own schema plus an envelope of `branchId` and `commitMessage`; `itemType` selects which. Permission is checked against the resource that type maps to (`parts:create` for a Part, and so on).
         *
         *     The server-assigned fields — `id`, `masterId`, `isCurrent`, `createdAt`/`createdBy`, `modifiedAt`/`modifiedBy`, `lockedBy`/`lockedAt` — are absent from the schema below because sending them has no effect. A blank `itemNumber` is auto-generated, and an omitted `revision` is assigned from the type’s lifecycle — send one only to carry a source system’s.
         *
         *     `ChangeOrder` is not creatable here — an ECO is defined by the designs it affects, so it goes through `POST /api/v1/change-orders`. A `WorkInstruction` must name its `outputPartId` and takes that part’s design; any `designId` sent with it must agree.
         */
        post: operations["postApiV1Items"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/batch-checkin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsBatchCheckin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/batch-checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsBatchCheckout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/batch-create": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsBatchCreate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/batch-delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsBatchDelete"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/batch-update": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsBatchUpdate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/by-filename/{filename}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByFilenameByFilename"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/enrich-from-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Suggest item fields from a web link */
        post: operations["postApiV1ItemsEnrichFromUrl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search items by free text or by item type
         * @description Pass `q` for a ranked text search across item number and name, or `itemType` for a by-type search that also returns a `total`. `limit` is uncapped but must be a positive integer.
         */
        get: operations["getApiV1ItemsSearch"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsById"];
        /**
         * Update an item
         * @description The body is validated against the update schema of the stored item’s own type — resolved at request time, so no single static schema can be documented here. Type-invalid values are rejected with 400 and `fieldErrors`; fields outside the type’s schema (including server-managed columns) are stripped. See the per-type `*UpdateSchema` shapes in the type-specific routes. All schemas accept `commitMessage` for branch saves.
         */
        put: operations["putApiV1ItemsById"];
        post?: never;
        delete: operations["deleteApiV1ItemsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/at-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdAtContext"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/available-contexts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdAvailableContexts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/cancel-checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsByIdCancelCheckout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/checkin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsByIdCheckin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdCheckout"];
        put?: never;
        post: operations["postApiV1ItemsByIdCheckout"];
        delete: operations["deleteApiV1ItemsByIdCheckout"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/edit-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdEditContext"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdGraph"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/impact-analysis": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsByIdImpactAnalysis"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/lock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsByIdLock"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/lock-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdLockStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/relationships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdRelationships"];
        put?: never;
        /**
         * Add a relationship from this item
         * @description The path item is the edge source. `(sourceId, targetId, relationshipType)` is unique, so re-adding an existing edge fails rather than duplicating it.
         */
        post: operations["postApiV1ItemsByIdRelationships"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/satisfied-requirements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdSatisfiedRequirements"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/sync-properties": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsByIdSyncProperties"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/thumbnail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdThumbnail"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/transition": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsByIdTransition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/transitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdTransitions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/unlock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ItemsByIdUnlock"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{id}/where-used": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByIdWhereUsed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{itemId}/cad-files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByItemIdCadFiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{itemId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByItemIdFiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{itemId}/files/primary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByItemIdFilesPrimary"];
        /**
         * Designate an item's primary 3D model
         * @description The primary model is the one the 3D viewer opens by default. Designates an already-uploaded file — upload with POST /api/v1/items/:itemId/files/upload first.
         */
        put: operations["putApiV1ItemsByItemIdFilesPrimary"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{itemId}/files/thumbnail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ItemsByItemIdFilesThumbnail"];
        /**
         * Designate an uploaded image as the item's thumbnail
         * @description Overrides the thumbnail generated from the CAD model. DELETE the same path to revert to the generated one.
         */
        put: operations["putApiV1ItemsByItemIdFilesThumbnail"];
        post?: never;
        delete: operations["deleteApiV1ItemsByItemIdFilesThumbnail"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{itemId}/files/upload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload one or more files to an item
         * @description `multipart/form-data`. Every part carrying a file is uploaded; the part name is free, and the client uses `file0`, `file1`, and so on. Two optional parts hang off each file part by name: `<name>_description` and `<name>_isThumbnail` (the string `true`). A single `branchId` part applies to the whole request. Uploading a STEP or IGES file does not convert it — call POST /api/v1/files/:fileId/convert with the returned id.
         */
        post: operations["postApiV1ItemsByItemIdFilesUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/items/{itemId}/model-versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List an item's versions with their viewable 3D models
         * @description Enumerates the released version, active branch working versions, and historical revisions of the item's master, each resolved to every viewable CAD model that version context offers — from the version row itself and from the Documents it links as CAD Docs. `files` is ordered so the first entry is the model that context displays by default, which `file` repeats. Powers the 3D comparison overlay on the part detail page.
         */
        get: operations["getApiV1ItemsByItemIdModelVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1JobsById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/lifecycles/by-item-type/{itemType}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1LifecyclesByItemTypeByItemType"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manufacturer-parts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search manufacturer parts */
        get: operations["getApiV1ManufacturerParts"];
        put?: never;
        /** Create a manufacturer part */
        post: operations["postApiV1ManufacturerParts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manufacturer-parts/mappings/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a manufacturer part from a part AML */
        delete: operations["deleteApiV1ManufacturerPartsMappingsById"];
        options?: never;
        head?: never;
        /** Update an AML mapping (qualification status, preferred) */
        patch: operations["patchApiV1ManufacturerPartsMappingsById"];
        trace?: never;
    };
    "/api/v1/manufacturer-parts/part/{masterId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the AML for a part (by master id) */
        get: operations["getApiV1ManufacturerPartsPartByMasterId"];
        put?: never;
        /** Attach a manufacturer part to a part AML */
        post: operations["postApiV1ManufacturerPartsPartByMasterId"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manufacturer-parts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a manufacturer part */
        get: operations["getApiV1ManufacturerPartsById"];
        /** Update a manufacturer part */
        put: operations["putApiV1ManufacturerPartsById"];
        post?: never;
        /** Delete a manufacturer part (cascades AML mappings) */
        delete: operations["deleteApiV1ManufacturerPartsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mbom": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1Mbom"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mbom/{designId}/upstream-changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1MbomByDesignIdUpstreamChanges"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mbom/{designId}/upstream-changes/{id}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1MbomByDesignIdUpstreamChangesByIdReview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/packages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List optional packages and whether they are enabled */
        get: operations["getApiV1Packages"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/parts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a part by ID */
        get: operations["getApiV1PartsById"];
        /** Update a part */
        put: operations["putApiV1PartsById"];
        post?: never;
        /** Delete a part */
        delete: operations["deleteApiV1PartsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/parts/{id}/resolvable-attributes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1PartsByIdResolvableAttributes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/parts/{id}/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1PartsByIdValidate"];
        delete: operations["deleteApiV1PartsByIdValidate"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/parts/{id}/validating-tests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1PartsByIdValidatingTests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/parts/{id}/work-instructions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1PartsByIdWorkInstructions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/physical-parts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search physical parts (units and lots) */
        get: operations["getApiV1PhysicalParts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/physical-parts/recall": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recall query: end items reachable from matching serials/lots */
        get: operations["getApiV1PhysicalPartsRecall"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/physical-parts/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Register a physical instance (find-or-create by part + serial/lot) */
        post: operations["postApiV1PhysicalPartsRegister"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/physical-parts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a physical part */
        get: operations["getApiV1PhysicalPartsById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update a physical part (state, notes, source, ERP ref) */
        patch: operations["patchApiV1PhysicalPartsById"];
        trace?: never;
    };
    "/api/v1/physical-parts/{id}/as-built-comparison": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** As-designed (BOM at the as-built part version) vs as-built (producing WO consumption) for a unit */
        get: operations["getApiV1PhysicalPartsByIdAsBuiltComparison"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/physical-parts/{id}/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1PhysicalPartsByIdEvidence"];
        put?: never;
        /** Assert that this instance's documents evidence a requirement */
        post: operations["postApiV1PhysicalPartsByIdEvidence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/physical-parts/{id}/evidence/{edgeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteApiV1PhysicalPartsByIdEvidenceByEdgeId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/physical-parts/{id}/genealogy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Derived genealogy (composition + where-used) for a unit/lot */
        get: operations["getApiV1PhysicalPartsByIdGenealogy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/programs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Programs"];
        put?: never;
        /**
         * Create a program
         * @description Programs are the permission boundary: the creator is not made a member, so add members with POST /api/v1/programs/:id/members. `code` is unique system-wide.
         */
        post: operations["postApiV1Programs"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/programs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ProgramsById"];
        put: operations["putApiV1ProgramsById"];
        post?: never;
        delete: operations["deleteApiV1ProgramsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/programs/{id}/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the scope graph for a program
         * @description Returns the program as a graph node with its designs below it, plus aggregated per-item-type counts across those designs for the graph view type filter.
         */
        get: operations["getApiV1ProgramsByIdGraph"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/programs/{id}/history/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ProgramsByIdHistoryGraph"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/programs/{id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ProgramsByIdMembers"];
        put?: never;
        post: operations["postApiV1ProgramsByIdMembers"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/programs/{id}/members/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putApiV1ProgramsByIdMembersByUserId"];
        post?: never;
        delete: operations["deleteApiV1ProgramsByIdMembersByUserId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/relationships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Relationships"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/relationships/batch-create": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create relationships in bulk
         * @description Up to 500 edges in one request — this is how a BOM is loaded. A line naming the same `(sourceId, targetId, relationshipType)` twice rejects the whole request with 400: the caller has to merge those lines and sum their quantities. Otherwise nothing is written until the batch is known to be insertable, and the status reports the outcome: 201 when every line was created, 207 when some lines were created and others rejected, 400 when none were.
         */
        post: operations["postApiV1RelationshipsBatchCreate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/relationships/{relationshipId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putApiV1RelationshipsByRelationshipId"];
        post?: never;
        delete: operations["deleteApiV1RelationshipsByRelationshipId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Reports"];
        put?: never;
        post: operations["postApiV1Reports"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reports/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ReportsById"];
        put: operations["putApiV1ReportsById"];
        post?: never;
        delete: operations["deleteApiV1ReportsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reports/{id}/execute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ReportsByIdExecute"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reports/{id}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1ReportsByIdExport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/requirements/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1RequirementsById"];
        put: operations["putApiV1RequirementsById"];
        post?: never;
        delete: operations["deleteApiV1RequirementsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/requirements/{id}/allocate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the items a requirement is allocated to */
        get: operations["getApiV1RequirementsByIdAllocate"];
        put?: never;
        /**
         * Allocate a requirement to design items
         * @description Creates ALLOCATED_TO links from the requirement to each item, closing the unallocated_requirement gap. Pass branchId to write them inside an ECO; without it the write lands on the rows named and is refused once the design has released items.
         */
        post: operations["postApiV1RequirementsByIdAllocate"];
        /** Remove a requirement allocation */
        delete: operations["deleteApiV1RequirementsByIdAllocate"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/requirements/{id}/derive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1RequirementsByIdDerive"];
        put?: never;
        /** Derive a child requirement from a requirement */
        post: operations["postApiV1RequirementsByIdDerive"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/requirements/{id}/parent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1RequirementsByIdParent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/requirements/{id}/satisfy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1RequirementsByIdSatisfy"];
        put?: never;
        post: operations["postApiV1RequirementsByIdSatisfy"];
        delete: operations["deleteApiV1RequirementsByIdSatisfy"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/requirements/{id}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1RequirementsByIdVerify"];
        delete: operations["deleteApiV1RequirementsByIdVerify"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/requirements/{id}/verifying-tests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1RequirementsByIdVerifyingTests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/roles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Roles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/setup/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1SetupComplete"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/setup/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1SetupProgress"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/setup/seed-catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1SetupSeedCatalog"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/setup/skip": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1SetupSkip"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/setup/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1SetupStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a software item by ID */
        get: operations["getApiV1SoftwareById"];
        /** Update a software item */
        put: operations["putApiV1SoftwareById"];
        post?: never;
        /** Delete a software item */
        delete: operations["deleteApiV1SoftwareById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/blob/{hash}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get source blob content by hash */
        get: operations["getApiV1SoftwareByIdBlobByHash"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/commit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Commit the draft source tree */
        post: operations["postApiV1SoftwareByIdCommit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Diff source trees between two software item versions */
        get: operations["getApiV1SoftwareByIdDiff"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/draft/discard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Discard the draft source tree */
        post: operations["postApiV1SoftwareByIdDraftDiscard"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/file": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a source file from a software item */
        get: operations["getApiV1SoftwareByIdFile"];
        /** Save a source file to the draft tree */
        put: operations["putApiV1SoftwareByIdFile"];
        post?: never;
        /** Delete a source file from the draft tree */
        delete: operations["deleteApiV1SoftwareByIdFile"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/file/rename": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rename a source file in the draft tree */
        post: operations["postApiV1SoftwareByIdFileRename"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Import source files into a software item */
        post: operations["postApiV1SoftwareByIdFiles"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the source tree of a software item */
        get: operations["getApiV1SoftwareByIdTree"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/software/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List all versions of a software item */
        get: operations["getApiV1SoftwareByIdVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sysml/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1SysmlProjects"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sysml/projects/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1SysmlProjectsById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sysml/projects/{id}/branches/{bid}/elements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1SysmlProjectsByIdBranchesByBidElements"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sysml/projects/{id}/commits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1SysmlProjectsByIdCommits"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sysml/projects/{id}/commits/{cid}/elements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1SysmlProjectsByIdCommitsByCidElements"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tags/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1TagsById"];
        put?: never;
        post?: never;
        delete: operations["deleteApiV1TagsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tasks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1TasksById"];
        put: operations["putApiV1TasksById"];
        post?: never;
        delete: operations["deleteApiV1TasksById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/test-cases/{id}/execute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record a test case execution */
        post: operations["postApiV1TestCasesByIdExecute"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/test-cases/{id}/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List execution history for a test case */
        get: operations["getApiV1TestCasesByIdExecutions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/test-plans/{id}/test-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the test cases belonging to a test plan */
        get: operations["getApiV1TestPlansByIdTestCases"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/thread/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the digital thread graph for an item */
        get: operations["getApiV1ThreadByItemId"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/thread/{itemId}/compare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Compare threads at two version contexts */
        post: operations["postApiV1ThreadByItemIdCompare"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/thread/{itemId}/comparison-targets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ThreadByItemIdComparisonTargets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tools/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1ToolsById"];
        put: operations["putApiV1ToolsById"];
        post?: never;
        delete: operations["deleteApiV1ToolsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Users"];
        put?: never;
        post: operations["postApiV1Users"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1UsersById"];
        put: operations["putApiV1UsersById"];
        post?: never;
        delete: operations["deleteApiV1UsersById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{id}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1UsersByIdActivate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{id}/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putApiV1UsersByIdPassword"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{id}/reset-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1UsersByIdResetPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{id}/roles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1UsersByIdRoles"];
        put: operations["putApiV1UsersByIdRoles"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-instructions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkInstructionsById"];
        put: operations["putApiV1WorkInstructionsById"];
        post?: never;
        delete: operations["deleteApiV1WorkInstructionsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-instructions/{id}/alerts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkInstructionsByIdAlerts"];
        put: operations["putApiV1WorkInstructionsByIdAlerts"];
        post: operations["postApiV1WorkInstructionsByIdAlerts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-instructions/{id}/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkInstructionsByIdOperations"];
        put: operations["putApiV1WorkInstructionsByIdOperations"];
        post: operations["postApiV1WorkInstructionsByIdOperations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-instructions/{id}/operations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putApiV1WorkInstructionsByIdOperationsByOperationId"];
        post?: never;
        delete: operations["deleteApiV1WorkInstructionsByIdOperationsByOperationId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-instructions/{id}/parts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkInstructionsByIdParts"];
        put?: never;
        post: operations["postApiV1WorkInstructionsByIdParts"];
        delete: operations["deleteApiV1WorkInstructionsByIdParts"];
        options?: never;
        head?: never;
        patch: operations["patchApiV1WorkInstructionsByIdParts"];
        trace?: never;
    };
    "/api/v1/work-instructions/{id}/resolve-parametric": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkInstructionsByIdResolveParametric"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-instructions/{id}/steps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkInstructionsByIdSteps"];
        put: operations["putApiV1WorkInstructionsByIdSteps"];
        post: operations["postApiV1WorkInstructionsByIdSteps"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-instructions/{id}/steps/{stepId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkInstructionsByIdStepsByStepId"];
        put: operations["putApiV1WorkInstructionsByIdStepsByStepId"];
        post?: never;
        delete: operations["deleteApiV1WorkInstructionsByIdStepsByStepId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-instructions/{id}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Where this template is instantiated: traveler lines across work orders, with progress */
        get: operations["getApiV1WorkInstructionsByIdUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrders"];
        put?: never;
        post: operations["postApiV1WorkOrders"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrdersById"];
        put: operations["putApiV1WorkOrdersById"];
        post?: never;
        delete: operations["deleteApiV1WorkOrdersById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrdersByIdExecutions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/executions/{executionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrdersByIdExecutionsByExecutionId"];
        put: operations["putApiV1WorkOrdersByIdExecutionsByExecutionId"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/executions/{executionId}/abandon": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Abandon an in-progress run (kept as an Incomplete record) */
        post: operations["postApiV1WorkOrdersByIdExecutionsByExecutionIdAbandon"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/executions/{executionId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1WorkOrdersByIdExecutionsByExecutionIdComplete"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/executions/{executionId}/resubmit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1WorkOrdersByIdExecutionsByExecutionIdResubmit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/executions/{executionId}/sign-off": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrdersByIdExecutionsByExecutionIdSignOff"];
        put?: never;
        post: operations["postApiV1WorkOrdersByIdExecutionsByExecutionIdSignOff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/instructions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the traveler: instruction instances with derived status and progress */
        get: operations["getApiV1WorkOrdersByIdInstructions"];
        /** Reorder traveler lines */
        put: operations["putApiV1WorkOrdersByIdInstructions"];
        /** Add a traveler line: instantiate a work instruction template (frozen snapshot) */
        post: operations["postApiV1WorkOrdersByIdInstructions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/instructions/populate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Populate the traveler from templates attached to the order's part and its BOM tree */
        post: operations["postApiV1WorkOrdersByIdInstructionsPopulate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/instructions/{instructionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrdersByIdInstructionsByInstructionId"];
        put?: never;
        post?: never;
        delete: operations["deleteApiV1WorkOrdersByIdInstructionsByInstructionId"];
        options?: never;
        head?: never;
        /** Update how many completed runs a traveler line needs */
        patch: operations["patchApiV1WorkOrdersByIdInstructionsByInstructionId"];
        trace?: never;
    };
    "/api/v1/work-orders/{id}/instructions/{instructionId}/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrdersByIdInstructionsByInstructionIdExecutions"];
        put?: never;
        /** Start (or resume) a run of a traveler line; auto-starts a Not Started order */
        post: operations["postApiV1WorkOrdersByIdInstructionsByInstructionIdExecutions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/instructions/{instructionId}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Re-freeze a traveler line from its template (only while unexecuted) */
        post: operations["postApiV1WorkOrdersByIdInstructionsByInstructionIdRefresh"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/instructions/{instructionId}/resolve-parametric": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve the snapshot's parametric blocks against current part data */
        get: operations["getApiV1WorkOrdersByIdInstructionsByInstructionIdResolveParametric"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/instructions/{instructionId}/skip": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Skip a traveler line (audited; requires a reason) */
        post: operations["postApiV1WorkOrdersByIdInstructionsByInstructionIdSkip"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/instructions/{instructionId}/unskip": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1WorkOrdersByIdInstructionsByInstructionIdUnskip"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/materials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrdersByIdMaterials"];
        put?: never;
        /** Consume material on a work order */
        post: operations["postApiV1WorkOrdersByIdMaterials"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/materials/{edgeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteApiV1WorkOrdersByIdMaterialsByEdgeId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/produce": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record serials produced by a work order */
        post: operations["postApiV1WorkOrdersByIdProduce"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/produced": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkOrdersByIdProduced"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/qualification": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Qualification rollup: requirements in scope, evidence, and gaps */
        get: operations["getApiV1WorkOrdersByIdQualification"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-orders/{id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putApiV1WorkOrdersByIdStatus"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workflows": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1Workflows"];
        put?: never;
        post: operations["postApiV1Workflows"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workflows/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkflowsById"];
        put: operations["putApiV1WorkflowsById"];
        post?: never;
        delete: operations["deleteApiV1WorkflowsById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workflows/{id}/approvers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkflowsByIdApprovers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workflows/{id}/states/{stateId}/approvers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApiV1WorkflowsByIdStatesByStateIdApprovers"];
        put: operations["putApiV1WorkflowsByIdStatesByStateIdApprovers"];
        post: operations["postApiV1WorkflowsByIdStatesByStateIdApprovers"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workflows/{id}/states/{stateId}/approvers/{approverId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteApiV1WorkflowsByIdStatesByStateIdApproversByApproverId"];
        options?: never;
        head?: never;
        patch: operations["patchApiV1WorkflowsByIdStatesByStateIdApproversByApproverId"];
        trace?: never;
    };
    "/api/v1/workflows/{id}/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postApiV1WorkflowsByIdValidate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the current user’s workspace branches */
        get: operations["getApiV1Workspaces"];
        put?: never;
        /** Create a workspace branch on a design */
        post: operations["postApiV1Workspaces"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a workspace with its design and item counts */
        get: operations["getApiV1WorkspacesById"];
        put?: never;
        post?: never;
        /** Delete a workspace, and with it any drafts that exist only there */
        delete: operations["deleteApiV1WorkspacesById"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{id}/convert-to-eco": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a new ECO carrying this workspace’s content */
        post: operations["postApiV1WorkspacesByIdConvertToEco"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the items on a workspace branch */
        get: operations["getApiV1WorkspacesByIdItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{id}/items/{masterId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove an item from a workspace, discarding the workspace’s changes to it */
        delete: operations["deleteApiV1WorkspacesByIdItemsByMasterId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{id}/merge-to-eco": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Move this workspace’s content into an existing ECO */
        post: operations["postApiV1WorkspacesByIdMergeToEco"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ErrorResponse: {
            error: {
                code: string;
                details?: string;
                fieldErrors?: {
                    code?: string;
                    field: string;
                    message: string;
                }[];
                message: string;
                requestId?: string;
                timestamp: string;
            };
        };
    };
    responses: {
        /** @description Permission denied */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Not found */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Server error */
        ServerError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Authentication required */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Validation error */
        ValidationError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getApiV1AdminAiSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminAiSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    config: {
                        apiKey?: string;
                        baseURL?: string;
                        model: string;
                        monthlyTokenBudget?: number;
                        /** @enum {string} */
                        provider: "openai" | "anthropic" | "gemini" | "ollama";
                    };
                    enabled: boolean;
                    /** @enum {string} */
                    provider: "openai" | "anthropic" | "gemini" | "ollama";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminAiSettingsModels: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    apiKey?: string;
                    baseURL?: string;
                    /** @enum {string} */
                    provider: "openai" | "anthropic" | "gemini" | "ollama";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            models: {
                                id: string;
                                label: string;
                            }[];
                            source: string;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminAiSettingsTest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    apiKey?: string;
                    baseURL?: string;
                    model: string;
                    /** @enum {string} */
                    provider: "openai" | "anthropic" | "gemini" | "ollama";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminApiKeyPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1AdminApiKeyPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    defaultExpirationDays?: number | null;
                    maxExpirationDays?: number | null;
                    requireExpiration?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminApiKeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1AdminApiKeysByKeyId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1AdminApiKeysByKeyId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    permissions?: {
                        [key: string]: string[];
                    } | null;
                    roles?: string[] | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminApiKeysByKeyIdActivity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminApiKeysByKeyIdDisable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminApiKeysByKeyIdEnable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminComponentCatalog: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminComponentCatalog: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    categoryId: string;
                    description?: string | null;
                    designNotes?: string | null;
                    dimensions?: {
                        depth?: number;
                        diameter?: number;
                        height?: number;
                        weight?: number;
                        width?: number;
                    } | null;
                    electrical?: {
                        current?: string | null;
                        interface?: string | null;
                        pinout?: string | null;
                        power?: string | null;
                        voltage?: string | null;
                    } | null;
                    /**
                     * @default component
                     * @enum {string}
                     */
                    entryType?: "component" | "raw_stock";
                    /** @default [] */
                    mountingFeatures?: {
                        /** @default {} */
                        specs?: {
                            [key: string]: unknown;
                        };
                        type: string;
                    }[];
                    name: string;
                    /** @default {} */
                    specs?: {
                        [key: string]: unknown;
                    };
                    stockSizes?: {
                        [key: string]: unknown;
                    }[] | null;
                    /** @default [] */
                    suppliers?: {
                        approximatePrice: number;
                        lastVerified?: string;
                        name: string;
                        partNumber?: string;
                        url?: string;
                    }[];
                    /** @default [] */
                    tags?: string[];
                    /** @default false */
                    verified?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminComponentCatalogCategories: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminComponentCatalogCategories: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    parentId?: string | null;
                    slug: string;
                    /** @default 0 */
                    sortOrder?: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1AdminComponentCatalogCategoriesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    parentId?: string | null;
                    slug?: string;
                    /** @default 0 */
                    sortOrder?: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1AdminComponentCatalogCategoriesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminComponentCatalogImport: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    rows: {
                        /** Format: uuid */
                        categoryId?: string;
                        categorySlug?: string;
                        description?: string | null;
                        designNotes?: string | null;
                        dimensions?: {
                            depth?: number;
                            diameter?: number;
                            height?: number;
                            weight?: number;
                            width?: number;
                        } | null;
                        electrical?: {
                            current?: string | null;
                            interface?: string | null;
                            pinout?: string | null;
                            power?: string | null;
                            voltage?: string | null;
                        } | null;
                        /**
                         * @default component
                         * @enum {string}
                         */
                        entryType?: "component" | "raw_stock";
                        /** @default [] */
                        mountingFeatures?: {
                            /** @default {} */
                            specs?: {
                                [key: string]: unknown;
                            };
                            type: string;
                        }[];
                        name: string;
                        /** @default {} */
                        specs?: {
                            [key: string]: unknown;
                        };
                        stockSizes?: {
                            [key: string]: unknown;
                        }[] | null;
                        /** @default [] */
                        suppliers?: {
                            approximatePrice: number;
                            lastVerified?: string;
                            name: string;
                            partNumber?: string;
                            url?: string;
                        }[];
                        /** @default [] */
                        tags?: string[];
                        /** @default false */
                        verified?: boolean;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminComponentCatalogById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1AdminComponentCatalogById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    categoryId?: string;
                    description?: string | null;
                    designNotes?: string | null;
                    dimensions?: {
                        depth?: number;
                        diameter?: number;
                        height?: number;
                        weight?: number;
                        width?: number;
                    } | null;
                    electrical?: {
                        current?: string | null;
                        interface?: string | null;
                        pinout?: string | null;
                        power?: string | null;
                        voltage?: string | null;
                    } | null;
                    /**
                     * @default component
                     * @enum {string}
                     */
                    entryType?: "component" | "raw_stock";
                    /** @default [] */
                    mountingFeatures?: {
                        /** @default {} */
                        specs?: {
                            [key: string]: unknown;
                        };
                        type: string;
                    }[];
                    name?: string;
                    /** @default {} */
                    specs?: {
                        [key: string]: unknown;
                    };
                    stockSizes?: {
                        [key: string]: unknown;
                    }[] | null;
                    /** @default [] */
                    suppliers?: {
                        approximatePrice: number;
                        lastVerified?: string;
                        name: string;
                        partNumber?: string;
                        url?: string;
                    }[];
                    /** @default [] */
                    tags?: string[];
                    /** @default false */
                    verified?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1AdminComponentCatalogById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminItemTypeConfigs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminItemTypeConfigs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    config: {
                        [key: string]: unknown;
                    };
                    itemType: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminItemTypeConfigsByItemType: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemType: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1AdminItemTypeConfigsByItemType: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemType: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminJobs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminJobsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminJobsByIdCancel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminJobsByIdRetry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminReloadConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    jsonValue?: unknown;
                    key: string;
                    value?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1AdminSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminThreadCacheCleanup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    maxAgeDays?: number;
                    maxInvalidatedAgeHours?: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminThreadCacheClear: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    confirm?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminThreadCacheStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AdminThreadCacheWarm: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    itemIds: string[];
                    request?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AdminVaultConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AiChat: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    data?: {
                        /** Format: uuid */
                        designId?: string;
                        /** @enum {string} */
                        mode?: "chat" | "search";
                        /** Format: uuid */
                        programId?: string;
                        /** Format: uuid */
                        sessionId?: string;
                    };
                    messages: {
                        content: string | null;
                        /** @enum {string} */
                        role: "system" | "user" | "assistant";
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AiSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AiSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    designId?: string;
                    /** Format: uuid */
                    programId?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AiSessionsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1AiSessionsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AiSessionsByIdMessages: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AiSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1AiSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    config: {
                        apiKey?: string;
                        baseURL?: string;
                        model: string;
                        monthlyTokenBudget?: number;
                        /** @enum {string} */
                        provider: "openai" | "anthropic" | "gemini" | "ollama";
                    };
                    enabled?: boolean;
                    /** Format: uuid */
                    programId?: string;
                    /** @enum {string} */
                    provider: "openai" | "anthropic" | "gemini" | "ollama";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AiSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    config: {
                        apiKey?: string;
                        baseURL?: string;
                        model: string;
                        monthlyTokenBudget?: number;
                        /** @enum {string} */
                        provider: "openai" | "anthropic" | "gemini" | "ollama";
                    };
                    enabled?: boolean;
                    /** Format: uuid */
                    programId?: string;
                    /** @enum {string} */
                    provider: "openai" | "anthropic" | "gemini" | "ollama";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AuthApiKeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AuthApiKeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: date-time */
                    expiresAt?: string;
                    name: string;
                    permissions?: {
                        [key: string]: string[];
                    } | null;
                    roles?: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1AuthApiKeysByKeyId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1AuthApiKeysByKeyId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    permissions?: {
                        [key: string]: string[];
                    } | null;
                    roles?: string[] | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AuthApiKeysByKeyIdActivity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AuthApiKeysByKeyIdDisable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AuthApiKeysByKeyIdEnable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AuthApiKeysByKeyIdRotate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                keyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AuthCallbackGithub: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AuthGithub: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AuthLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    password: string;
                    username: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1AuthLogout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1AuthPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    currentPassword: string;
                    password: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AuthPermissions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1AuthSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1BranchItemsByIdPullFromMain: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    mainItemId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1BranchItemsByIdRebase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    newBaseItemId: string;
                    resolutions?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1BranchesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1BranchesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @constant */
                    isArchived?: true;
                    isLocked?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1BranchesByIdCommits: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1BranchesByIdItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1BranchesByIdStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    designIds: string[];
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersEditable: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ChangeOrdersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    changeType?: "ECO" | "ECN" | "Deviation" | "MCO" | "XCO";
                    commitMessage?: string;
                    description?: string;
                    impactDescription?: string;
                    /** Format: date-time */
                    implementationDate?: string;
                    name?: string;
                    /** @enum {string} */
                    priority?: "low" | "medium" | "high" | "critical";
                    reasonForChange?: string;
                    /** @enum {string} */
                    riskLevel?: "low" | "medium" | "high" | "critical";
                    state?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ChangeOrdersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdAffectedItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdAffectedItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    affectedItemId?: string | null;
                    affectedItemMasterId?: string | null;
                    /** @enum {string} */
                    changeAction: "release" | "revise" | "obsolete" | "promote";
                    changeDescription?: string | null;
                    currentRevision?: string | null;
                    currentState?: string | null;
                    newItemData?: {
                        [key: string]: unknown;
                    } | null;
                    newItemType?: string | null;
                    replacementItemId?: string | null;
                } | {
                    items: {
                        affectedItemId?: string | null;
                        affectedItemMasterId?: string | null;
                        /** @enum {string} */
                        changeAction: "release" | "revise" | "obsolete" | "promote";
                        changeDescription?: string | null;
                        currentRevision?: string | null;
                        currentState?: string | null;
                        newItemData?: {
                            [key: string]: unknown;
                        } | null;
                        newItemType?: string | null;
                        replacementItemId?: string | null;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ChangeOrdersByIdAffectedItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdAffectedItemsPreview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    itemIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdApprovals: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdApprovals: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comments?: string;
                    /** Format: uuid */
                    roleId?: string;
                    /** @enum {string} */
                    vote: "approved" | "rejected";
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdApprovalsCanApprove: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdApprovalsByStateId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdApprovalsByStateId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comments?: string;
                    /** Format: uuid */
                    roleId?: string;
                    /** @enum {string} */
                    vote: "approved" | "rejected";
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdBomChanges: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @default add
                     * @enum {string}
                     */
                    action?: "add" | "remove" | "modify";
                    /** Format: uuid */
                    childItemId: string;
                    findNumber?: number;
                    /** Format: uuid */
                    parentItemId: string;
                    /** @default 1 */
                    quantity?: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ChangeOrdersByIdBomChanges: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdBranchHistory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdBranchHistoryGraph: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdCheckout: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    itemId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdConflictReviews: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdConflictReviews: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    conflictType: string;
                    /** Format: uuid */
                    itemMasterId: string;
                    notes?: string;
                    theirEcoId?: string | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ChangeOrdersByIdConflictReviews: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdConflicts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdDesigns: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdDesigns: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    designId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdDesignsByDesignIdStructure: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                designId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdImpactAssessment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdImpactAssessment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default true */
                    includeCrossChanges?: boolean;
                    /** @default true */
                    includeDocuments?: boolean;
                    /** @default 15 */
                    maxDepth?: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdItemsByItemIdAncestors: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdRelease: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdResolveConflicts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    resolutions: {
                        /** Format: uuid */
                        itemId: string;
                        /** @enum {string} */
                        resolution: "keep_ours" | "keep_theirs" | "skip";
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdRisks: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdRisks: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdWorkflow: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdWorkflow: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    workflowDefinitionId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdWorkflowHistory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdWorkflowStatesByStateIdApprovers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ChangeOrdersByIdWorkflowStatesByStateIdApprovers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    approvers: {
                        /** Format: uuid */
                        id: string;
                        /** @default true */
                        isRequired?: boolean;
                        /** @enum {string} */
                        type: "user" | "role";
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdWorkflowStructure: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ChangeOrdersByIdWorkflowStructure: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    states: {
                        color?: string;
                        description?: string;
                        /** @enum {string} */
                        finalKind?: "release" | "cancel" | "complete";
                        id: string;
                        instructions?: string;
                        isFinal?: boolean;
                        isInitial?: boolean;
                        name: string;
                        phaseId?: string;
                        position?: {
                            x: number;
                            y: number;
                        };
                    }[];
                    transitions: {
                        actions?: ({
                            config: {
                                recipients: {
                                    id: string;
                                    /** @enum {string} */
                                    type: "user" | "role";
                                }[];
                                /** @constant */
                                templateId: "workflow_transition";
                            };
                            /** @enum {string} */
                            executeOn: "before" | "after";
                            id: string;
                            name: string;
                            /** @constant */
                            type: "send_notification";
                        } | {
                            config: {
                                fieldName: string;
                                value: string | number | boolean;
                            };
                            /** @enum {string} */
                            executeOn: "before" | "after";
                            id: string;
                            name: string;
                            /** @constant */
                            type: "update_field";
                        })[];
                        approvalRequirement?: {
                            requiredCount: number;
                        };
                        description?: string;
                        fromStateId: string;
                        guards?: ({
                            config: {
                                fieldName: string;
                                /** @enum {string} */
                                operator: "equals" | "not_equals" | "contains" | "is_empty" | "is_not_empty" | "greater_than" | "less_than" | "greater_or_equal" | "less_or_equal";
                                value?: string | number | boolean;
                            };
                            errorMessage?: string;
                            id: string;
                            name: string;
                            /** @constant */
                            type: "field_value";
                        } | {
                            config: {
                                requireAll?: boolean;
                                requiredRoles: string[];
                            };
                            errorMessage?: string;
                            id: string;
                            name: string;
                            /** @constant */
                            type: "user_role";
                        })[];
                        id: string;
                        labelPosition?: {
                            x: number;
                            y: number;
                        };
                        name: string;
                        toStateId: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ChangeOrdersByIdWorkflowTransition: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdWorkflowTransition: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comments?: string;
                    toStateId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ChangeOrdersByIdWorkflowValidateTransition: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comments?: string;
                    toStateId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1CommitsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1CommitsByIdDiff: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1CommitsByIdItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DashboardCharts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DashboardStats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Designs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1Designs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    attributes?: {
                        [key: string]: unknown;
                    };
                    cloneSourceDesignId?: string | null;
                    code: string;
                    description?: string | null;
                    /**
                     * @default Engineering
                     * @enum {string}
                     */
                    designType?: "Engineering" | "Library" | "Family";
                    name: string;
                    parentDesignId?: string | null;
                    plannedQuantity?: number | null;
                    programId?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            design: {
                                code: string;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                programId: string | null;
                            } & {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsFamilies: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByDesignIdGapAnalysis: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                designId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1DesignsByDesignIdGapAnalysis: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                designId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    includeDomains?: ("requirements" | "engineering" | "manufacturing" | "validation")[];
                    includeSeverities?: ("critical" | "major" | "minor")[];
                    includeTypes?: ("unallocated_requirement" | "unsatisfied_requirement" | "unverified_requirement" | "untested_part" | "unmapped_ebom_item" | "orphan_mbom_item" | "missing_documentation")[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByDesignIdRequirementsCoverage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                designId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByDesignIdTestCoverage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                designId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByDesignIdVerificationGaps: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                designId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1DesignsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    attributes?: {
                        [key: string]: unknown;
                    };
                    cloneSourceDesignId?: string | null;
                    code?: string;
                    description?: string | null;
                    name?: string;
                    parentDesignId?: string | null;
                    plannedQuantity?: number | null;
                    programId?: string | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1DesignsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdBranches: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1DesignsByIdBranches: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @constant */
                    branchType: "eco";
                    /** Format: uuid */
                    changeOrderItemId: string;
                } | {
                    /** @constant */
                    branchType: "workspace";
                    name: string;
                } | {
                    /** @constant */
                    branchType: "release";
                    name: string;
                    /** Format: uuid */
                    sourceTagId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1DesignsByIdClone: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    code: string;
                    description?: string;
                    name: string;
                    /** Format: uuid */
                    programId?: string;
                    suffixItemNumbers?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdCrossReferences: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1DesignsByIdCrossReferences: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    branchId?: string | null;
                    notes?: string;
                    /** Format: uuid */
                    referencedItemId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1DesignsByIdCrossReferences: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    branchId?: string | null;
                    itemIds?: string[];
                    parentBomRelationshipId?: string | null;
                    /** Format: uuid */
                    refId?: string;
                    suffixItemNumber?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1DesignsByIdCrossReferences: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdDetails: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdEcos: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdGraph: {
        parameters: {
            query?: {
                direction?: "all" | "up" | "down";
                itemTypes?: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            availableItemTypes: {
                                count: number;
                                itemType: string;
                            }[];
                            edges: {
                                data: {
                                    [key: string]: unknown;
                                };
                                id: string;
                                label: string;
                                source: string;
                                target: string;
                            }[];
                            nodes: {
                                data: {
                                    [key: string]: unknown;
                                };
                                id: string;
                                position: {
                                    x: number;
                                    y: number;
                                };
                                type: string;
                            }[];
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdHistoryGraph: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1DesignsByIdItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    /** Format: uuid */
                    itemId: string;
                    /**
                     * @default usage_copy
                     * @enum {string}
                     */
                    mode?: "usage_copy" | "cross_design_ref";
                    suffixItemNumber?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1DesignsByIdItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1DesignsByIdItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    itemId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1DesignsByIdMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    designId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1DesignsByIdMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdStructure: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DesignsByIdTags: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1DesignsByIdTags: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    name: string;
                    /**
                     * @default baseline
                     * @enum {string}
                     */
                    tagType?: "baseline" | "release" | "milestone" | "eco-release";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1DocumentsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1DocumentsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    commitMessage?: string;
                    description?: string;
                    /** Format: uuid */
                    fileId?: string;
                    fileName?: string;
                    name?: string;
                    state?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1DocumentsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1EnterpriseSearch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1EnterpriseSearchResults: {
        parameters: {
            query?: {
                globalSearch?: string;
                limit?: number;
                offset?: number;
                sortField?: string;
                sortDirection?: "asc" | "desc";
                columnFilters?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            items: {
                                createdAt: string | null;
                                designCode: string | null;
                                designId: string | null;
                                designName: string | null;
                                /** Format: uuid */
                                id: string;
                                itemNumber: string;
                                itemType: string;
                                modifiedAt: string | null;
                                name: string | null;
                                programCode: string | null;
                                programId: string | null;
                                programName: string | null;
                                revision: string | null;
                                state: string | null;
                            }[];
                            total: number;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Files: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1FilesBatchCheckin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    fileIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1FilesBatchCheckout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    fileIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1FilesByFileId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1FilesByFileIdAnnotations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1FilesByFileIdAnnotations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    color: string;
                    contents?: string | null;
                    geometry: {
                        /** @constant */
                        kind: "highlight";
                        rect: {
                            height: number;
                            width: number;
                            x: number;
                            y: number;
                        };
                    } | {
                        /** @constant */
                        kind: "rect";
                        rect: {
                            height: number;
                            width: number;
                            x: number;
                            y: number;
                        };
                    } | {
                        /** @constant */
                        kind: "ink";
                        strokes: {
                            x: number;
                            y: number;
                        }[][];
                        width: number;
                    } | {
                        anchor: {
                            x: number;
                            y: number;
                        };
                        /** @constant */
                        kind: "note";
                    } | {
                        anchor: {
                            x: number;
                            y: number;
                        };
                        fontSize: number;
                        /** @constant */
                        kind: "text";
                    };
                    pageNumber: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1FilesByFileIdAnnotationsByAnnotationId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
                annotationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1FilesByFileIdAnnotationsByAnnotationId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
                annotationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    color?: string;
                    contents?: string | null;
                    geometry?: {
                        /** @constant */
                        kind: "highlight";
                        rect: {
                            height: number;
                            width: number;
                            x: number;
                            y: number;
                        };
                    } | {
                        /** @constant */
                        kind: "rect";
                        rect: {
                            height: number;
                            width: number;
                            x: number;
                            y: number;
                        };
                    } | {
                        /** @constant */
                        kind: "ink";
                        strokes: {
                            x: number;
                            y: number;
                        }[][];
                        width: number;
                    } | {
                        anchor: {
                            x: number;
                            y: number;
                        };
                        /** @constant */
                        kind: "note";
                    } | {
                        anchor: {
                            x: number;
                            y: number;
                        };
                        fontSize: number;
                        /** @constant */
                        kind: "text";
                    };
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1FilesByFileIdCategory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    category: ("cad_model" | "drawing" | "specification" | "analysis" | "reference" | "other") | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            file: {
                                /** @enum {string} */
                                categorySource: "auto" | "manual";
                                fileCategory: string | null;
                                /** Format: uuid */
                                id: string;
                                isPrimaryModel: boolean;
                            };
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1FilesByFileIdCheckin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1FilesByFileIdCheckout: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1FilesByFileIdContent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File content, inline. 415 if the format is not previewable, 413 if it exceeds the preview size ceiling. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": unknown;
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1FilesByFileIdConvert: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /**
                     * @description Split a multi-solid assembly into one mesh per solid instead of one mesh for the whole file.
                     * @default false
                     */
                    decompose?: boolean;
                    /**
                     * @default standard
                     * @enum {string}
                     */
                    meshQuality?: "preview" | "standard" | "high";
                    /**
                     * Format: uuid
                     * @description Attach the converted mesh to this item instead of the source file’s own — e.g. a STEP held on a Document producing an STL on the Part.
                     */
                    targetItemId?: string;
                };
            };
        };
        responses: {
            /** @description Conversion queued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            /** Format: uuid */
                            jobId: string;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1FilesByFileIdDownload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1FilesByFileIdForceUnlock: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1FilesByFileIdLockStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1FilesByFileIdMetadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1FilesByFileIdThumbnail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1FilesByFileIdVersions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1FilesByFileIdVersionsByVersionDownload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
                version: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1FilesByFileIdWatermark: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fileId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default #dc2626 */
                    color?: string;
                    /** @default 0.25 */
                    opacity?: number;
                    /**
                     * @default diagonal
                     * @enum {string}
                     */
                    position?: "diagonal" | "top-banner" | "bottom-banner";
                    reason?: string;
                    subtext?: string | null;
                    text: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ImportDocuments: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    /** @default false */
                    bypassBranchProtection?: boolean;
                    /** Format: uuid */
                    designId: string;
                    rows: {
                        attributes?: {
                            [key: string]: string;
                        };
                        description?: string;
                        /** @enum {string} */
                        docType?: "Specification" | "Drawing" | "Procedure" | "Manual" | "Report" | "Other";
                        fileName?: string;
                        itemNumber?: string;
                        mimeType?: string;
                        name: string;
                        /** @default - */
                        revision?: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ImportIssues: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    programId?: string;
                    rows: {
                        attributes?: {
                            [key: string]: string;
                        };
                        /** @enum {string} */
                        category?: "Design" | "Manufacturing" | "Quality" | "Customer" | "Safety" | "Other";
                        description?: string;
                        itemNumber?: string;
                        name: string;
                        /** @enum {string} */
                        priority?: "Critical" | "High" | "Medium" | "Low";
                        reportedDate?: string;
                        resolution?: string;
                        rootCause?: string;
                        /** @enum {string} */
                        severity?: "Critical" | "High" | "Medium" | "Low";
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ImportParts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    bomRelationships?: {
                        childItemNumber: string;
                        findNumber?: number;
                        parentItemNumber: string;
                        /** @default 1 */
                        quantity?: number;
                        referenceDesignator?: string;
                    }[];
                    /** Format: uuid */
                    branchId?: string;
                    /** @default false */
                    bypassBranchProtection?: boolean;
                    /** Format: uuid */
                    designId: string;
                    rows: {
                        attributes?: {
                            [key: string]: string;
                        };
                        cost?: string;
                        costCurrency?: string;
                        description?: string;
                        itemNumber?: string;
                        leadTimeDays?: number;
                        material?: string;
                        name: string;
                        /** @enum {string} */
                        partType?: "Manufacture" | "Purchase" | "Software" | "Phantom";
                        /** @default - */
                        revision?: string;
                        weight?: string;
                        weightUnit?: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ImportTemplatesDocuments: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ImportTemplatesIssues: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ImportTemplatesParts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1IssuesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1IssuesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    affectedItemIds?: string[];
                    assignedTo?: string | null;
                    attributes?: {
                        [key: string]: unknown;
                    };
                    category?: ("Design" | "Manufacturing" | "Quality" | "Customer" | "Safety" | "Other") | null;
                    commitMessage?: string;
                    description?: string | null;
                    designIds?: string[];
                    name?: string | null;
                    priority?: ("Critical" | "High" | "Medium" | "Low") | null;
                    programId?: string | null;
                    reportedBy?: string | null;
                    reportedDate?: string | null;
                    resolution?: string | null;
                    resolvedDate?: string | null;
                    rootCause?: string | null;
                    severity?: ("Critical" | "High" | "Medium" | "Low") | null;
                    state?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1IssuesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Items: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1Items: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    commitMessage?: string;
                    itemType: string;
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description The created item. `commit` is present only for a branch write. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            commit?: {
                                /** Format: uuid */
                                id: string;
                                message: string;
                            } & {
                                [key: string]: unknown;
                            };
                            item: {
                                /** Format: uuid */
                                id: string;
                                itemNumber: string;
                                itemType: string;
                                /** Format: uuid */
                                masterId: string;
                                revision: string;
                                state: string;
                            } & {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsBatchCheckin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId: string;
                    itemIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsBatchCheckout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId: string;
                    itemIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsBatchCreate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default false */
                    bypassBranchProtection?: boolean;
                    items: {
                        data: {
                            [key: string]: unknown;
                        };
                        /** @enum {string} */
                        itemType: "Part" | "Document" | "Requirement" | "Task" | "ChangeOrder";
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsBatchDelete: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId: string;
                    commitMessage?: string;
                    itemIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsBatchUpdate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    commitMessage?: string;
                    items: {
                        data: {
                            [key: string]: unknown;
                        };
                        /** Format: uuid */
                        id: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByFilenameByFilename: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                filename: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsEnrichFromUrl: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    itemType: "Part" | "Tool";
                    /** Format: uri */
                    url: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsSearch: {
        parameters: {
            query?: {
                q?: string;
                itemType?: string;
                types?: string;
                query?: string;
                state?: string;
                limit?: number;
                offset?: number;
                designScope?: "current" | "all" | "library";
                contextDesignId?: string;
                designIds?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ItemsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ItemsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdAtContext: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdAvailableContexts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdCancelCheckout: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdCheckin: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdCheckout: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdCheckout: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ItemsByIdCheckout: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdEditContext: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdGraph: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdHistory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdImpactAnalysis: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    changeType: "revision" | "obsolescence" | "bom_removal" | "specification_change";
                    /** @enum {string} */
                    direction: "upstream" | "downstream" | "both";
                    /**
                     * @default [
                     *       "requirements",
                     *       "engineering",
                     *       "manufacturing",
                     *       "validation"
                     *     ]
                     */
                    includeDomains?: ("requirements" | "engineering" | "manufacturing" | "validation")[];
                    /** @default 5 */
                    maxDepth?: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdLock: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    force?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdLockStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdRelationships: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdRelationships: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    findNumber?: number;
                    /** @description Stored as text, so a string arrives verbatim — BOM quantities are not all integers. */
                    quantity?: number | string;
                    referenceDesignator?: string;
                    /** @description e.g. `BOM`, `Document`, `Satisfies`, `Consumes` */
                    relationshipType: string;
                    /** Format: uuid */
                    targetId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            success: boolean;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdSatisfiedRequirements: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdSyncProperties: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    properties: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdThumbnail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdTransition: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comments?: string;
                    toState?: string;
                    toStateId?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdTransitions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByIdUnlock: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    force?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByIdWhereUsed: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByItemIdCadFiles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByItemIdFiles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByItemIdFilesPrimary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ItemsByItemIdFilesPrimary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * Format: uuid
                     * @description A file already uploaded to this item. Must belong to it.
                     */
                    fileId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            /** Format: uuid */
                            fileId: string;
                            message: string;
                            success: boolean;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByItemIdFilesThumbnail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ItemsByItemIdFilesThumbnail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * Format: uuid
                     * @description A file already uploaded to this item. Must belong to it.
                     */
                    fileId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            /** Format: uuid */
                            fileId: string;
                            message: string;
                            success: boolean;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ItemsByItemIdFilesThumbnail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ItemsByItemIdFilesUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    /**
                     * Format: uuid
                     * @description Attach the files in this ECO branch’s version context. Omitted, they attach on main.
                     */
                    branchId?: string;
                    /**
                     * Format: binary
                     * @description First file. Repeat as file1, file2, …
                     */
                    file0?: string;
                    /** @description Description stored against `file0`. */
                    file0_description?: string;
                    /**
                     * @description `true` designates `file0` as the item thumbnail.
                     * @enum {string}
                     */
                    file0_isThumbnail?: "true" | "false";
                } & {
                    [key: string]: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            count: number;
                            files: ({
                                branchId: string | null;
                                /** @description SHA-256 of the stored bytes */
                                fileHash: string;
                                fileName: string;
                                fileSize: number;
                                fileVersion: number;
                                /** Format: uuid */
                                id: string;
                                isItemThumbnail: boolean;
                                isPrimaryModel: boolean | null;
                                /** Format: uuid */
                                itemId: string;
                                mimeType: string;
                                originalFileName: string;
                            } & {
                                [key: string]: unknown;
                            })[];
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ItemsByItemIdModelVersions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            versions: {
                                branch: {
                                    branchType: string;
                                    changeOrderItemId: string | null;
                                    changeOrderNumber: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    name: string;
                                } | null;
                                file: {
                                    fileName: string;
                                    fileSize: number;
                                    fileType: string;
                                    hasColors: boolean;
                                    /** Format: uuid */
                                    id: string;
                                    isPrimaryModel: boolean;
                                    /** @enum {string} */
                                    source: "direct" | "cad_doc";
                                    /** Format: uuid */
                                    sourceItemId: string;
                                    sourceItemNumber: string | null;
                                    uploadedAt: string;
                                } | null;
                                files: {
                                    fileName: string;
                                    fileSize: number;
                                    fileType: string;
                                    hasColors: boolean;
                                    /** Format: uuid */
                                    id: string;
                                    isPrimaryModel: boolean;
                                    /** @enum {string} */
                                    source: "direct" | "cad_doc";
                                    /** Format: uuid */
                                    sourceItemId: string;
                                    sourceItemNumber: string | null;
                                    uploadedAt: string;
                                }[];
                                /** Format: uuid */
                                itemId: string;
                                key: string;
                                /** @enum {string} */
                                kind: "current" | "branch" | "historical";
                                modifiedAt: string;
                                revision: string;
                                state: string;
                            }[];
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1JobsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1LifecyclesByItemTypeByItemType: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemType: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ManufacturerParts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ManufacturerParts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uri */
                    datasheetUrl?: string;
                    description?: string;
                    manufacturer: string;
                    mpn: string;
                    notes?: string;
                    specs?: {
                        [key: string]: unknown;
                    };
                    supplierLinks?: {
                        leadTimeDays?: number;
                        price?: number;
                        sku?: string;
                        supplier: string;
                        /** Format: uri */
                        url?: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ManufacturerPartsMappingsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1ManufacturerPartsMappingsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    isPreferred?: boolean;
                    notes?: string | null;
                    /** @enum {string} */
                    qualificationStatus?: "proposed" | "approved" | "obsolete";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ManufacturerPartsPartByMasterId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                masterId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ManufacturerPartsPartByMasterId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                masterId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    isPreferred?: boolean;
                    manufacturerPart?: {
                        /** Format: uri */
                        datasheetUrl?: string;
                        description?: string;
                        manufacturer: string;
                        mpn: string;
                        notes?: string;
                        specs?: {
                            [key: string]: unknown;
                        };
                        supplierLinks?: {
                            leadTimeDays?: number;
                            price?: number;
                            sku?: string;
                            supplier: string;
                            /** Format: uri */
                            url?: string;
                        }[];
                    };
                    /** Format: uuid */
                    manufacturerPartId?: string;
                    notes?: string;
                    /** @enum {string} */
                    qualificationStatus?: "proposed" | "approved" | "obsolete";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ManufacturerPartsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ManufacturerPartsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uri */
                    datasheetUrl?: string;
                    description?: string;
                    manufacturer?: string;
                    mpn?: string;
                    notes?: string;
                    specs?: {
                        [key: string]: unknown;
                    };
                    supplierLinks?: {
                        leadTimeDays?: number;
                        price?: number;
                        sku?: string;
                        supplier: string;
                        /** Format: uri */
                        url?: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ManufacturerPartsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1Mbom: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    code: string;
                    /** @default true */
                    copyBomStructure?: boolean;
                    description?: string;
                    /** @default true */
                    linkToSource?: boolean;
                    name: string;
                    /** @default true */
                    renumberItems?: boolean;
                    /** Format: uuid */
                    sourceDesignId: string;
                    /** Format: uuid */
                    sourceTagId?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1MbomByDesignIdUpstreamChanges: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                designId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1MbomByDesignIdUpstreamChangesByIdReview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                designId: string;
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action: "accept" | "reject" | "defer";
                    createMco?: boolean;
                    notes?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Packages: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            packages: {
                                description: string;
                                enabled: boolean;
                                features: string[];
                                id: string;
                                name: string;
                            }[];
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PartsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            part: {
                                /** Format: uuid */
                                id: string;
                                name: string | null;
                                partType: string | null;
                            } & {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1PartsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    attributes?: {
                        [key: string]: unknown;
                    };
                    commitMessage?: string;
                    cost?: string | null;
                    costCurrency?: string | null;
                    description?: string | null;
                    leadTimeDays?: number | null;
                    material?: string | null;
                    name?: string | null;
                    partType?: ("Manufacture" | "Purchase" | "Software" | "Phantom") | null;
                    state?: string;
                    /** @enum {string} */
                    trackingMode?: "none" | "lot" | "serial";
                    weight?: string | null;
                    weightUnit?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            part: {
                                /** Format: uuid */
                                id: string;
                                name: string | null;
                                partType: string | null;
                            } & {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1PartsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            success: boolean;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PartsByIdResolvableAttributes: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1PartsByIdValidate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    testCaseIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1PartsByIdValidate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PartsByIdValidatingTests: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PartsByIdWorkInstructions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PhysicalParts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PhysicalPartsRecall: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1PhysicalPartsRegister: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    erpRef?: string;
                    lotNumber?: string;
                    /** Format: uuid */
                    manufacturerPartId?: string;
                    notes?: string;
                    /** Format: uuid */
                    partMasterId: string;
                    serialNumber?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PhysicalPartsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1PhysicalPartsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    erpRef?: string | null;
                    manufacturerPartId?: string | null;
                    name?: string;
                    notes?: string | null;
                    state?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PhysicalPartsByIdAsBuiltComparison: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PhysicalPartsByIdEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1PhysicalPartsByIdEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    note?: string;
                    /** Format: uuid */
                    requirementId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1PhysicalPartsByIdEvidenceByEdgeId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                edgeId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1PhysicalPartsByIdGenealogy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Programs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1Programs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    attributes?: {
                        [key: string]: unknown;
                    };
                    code: string;
                    contractNumber?: string;
                    customer?: string;
                    description?: string;
                    name: string;
                    /** Format: date-time */
                    startDate?: string;
                    /** @enum {string} */
                    status?: "Active" | "On Hold" | "Completed" | "Cancelled";
                    /** Format: date-time */
                    targetEndDate?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            program: {
                                code: string;
                                /** Format: uuid */
                                id: string;
                                name: string;
                            } & {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ProgramsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ProgramsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    attributes?: {
                        [key: string]: unknown;
                    };
                    code?: string;
                    contractNumber?: string;
                    customer?: string;
                    description?: string;
                    name?: string;
                    /** Format: date-time */
                    startDate?: string;
                    /** @enum {string} */
                    status?: "Active" | "On Hold" | "Completed" | "Cancelled";
                    /** Format: date-time */
                    targetEndDate?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ProgramsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ProgramsByIdGraph: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            availableItemTypes: {
                                count: number;
                                itemType: string;
                            }[];
                            edges: {
                                data: {
                                    [key: string]: unknown;
                                };
                                id: string;
                                label: string;
                                source: string;
                                target: string;
                            }[];
                            nodes: {
                                data: {
                                    [key: string]: unknown;
                                };
                                id: string;
                                position: {
                                    x: number;
                                    y: number;
                                };
                                type: string;
                            }[];
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ProgramsByIdHistoryGraph: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ProgramsByIdMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ProgramsByIdMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    role: "admin" | "lead" | "engineer" | "viewer";
                    /** Format: uuid */
                    userId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ProgramsByIdMembersByUserId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                userId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    canApproveEco?: boolean;
                    canCreateEco?: boolean;
                    canManageDesigns?: boolean;
                    /** @enum {string} */
                    role?: "admin" | "lead" | "engineer" | "viewer";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ProgramsByIdMembersByUserId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Relationships: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1RelationshipsBatchCreate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    relationships: {
                        [key: string]: unknown;
                    }[];
                    replaceExisting?: boolean;
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            created: number;
                            errors: {
                                error: string;
                                relationship: {
                                    findNumber?: number;
                                    metadata?: {
                                        [key: string]: unknown;
                                    };
                                    quantity?: number | string;
                                    referenceDesignator?: string;
                                    /** @description e.g. `BOM`, `Document`, `Satisfies`, `Consumes` */
                                    relationshipType: string;
                                    /** Format: uuid */
                                    sourceId: string;
                                    /** Format: uuid */
                                    targetId: string;
                                };
                            }[];
                            skipped: number;
                        };
                    };
                };
            };
            /** @description Some lines created, others rejected */
            207: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            created: number;
                            errors: {
                                error: string;
                                relationship: {
                                    findNumber?: number;
                                    metadata?: {
                                        [key: string]: unknown;
                                    };
                                    quantity?: number | string;
                                    referenceDesignator?: string;
                                    /** @description e.g. `BOM`, `Document`, `Satisfies`, `Consumes` */
                                    relationshipType: string;
                                    /** Format: uuid */
                                    sourceId: string;
                                    /** Format: uuid */
                                    targetId: string;
                                };
                            }[];
                            skipped: number;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1RelationshipsByRelationshipId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                relationshipId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    findNumber?: number | null;
                    quantity?: (number | string) | null;
                    referenceDesignator?: string | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1RelationshipsByRelationshipId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                relationshipId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Reports: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1Reports: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    columns: {
                        displayOrder: number;
                        fieldPath: string;
                        formatType?: ("text" | "number" | "currency" | "date" | "datetime" | "boolean" | "email" | "url" | "percentage") | null;
                        /** Format: uuid */
                        id?: string;
                        /** @default true */
                        isVisible?: boolean;
                        label: string;
                        /** Format: uuid */
                        reportId?: string;
                        width?: number | null;
                    }[];
                    config?: {
                        [key: string]: unknown;
                    } | null;
                    description?: string | null;
                    /** @default [] */
                    filters?: {
                        displayOrder: number;
                        fieldPath: string;
                        /** Format: uuid */
                        id?: string;
                        /** @enum {string} */
                        operator: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "like" | "not_like" | "in" | "not_in" | "is_null" | "is_not_null" | "starts_with" | "ends_with" | "between";
                        /** Format: uuid */
                        reportId?: string;
                        value?: string | null;
                        value2?: string | null;
                    }[];
                    /** Format: uuid */
                    id?: string;
                    /** @default false */
                    isPublic?: boolean;
                    itemType: string;
                    name: string;
                    sharedWithRoles?: string[] | null;
                    sharedWithUsers?: string[] | null;
                    /** @default [] */
                    sorts?: {
                        /** @enum {string} */
                        direction: "asc" | "desc";
                        fieldPath: string;
                        /** Format: uuid */
                        id?: string;
                        priority: number;
                        /** Format: uuid */
                        reportId?: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ReportsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ReportsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    columns?: {
                        displayOrder: number;
                        fieldPath: string;
                        formatType?: ("text" | "number" | "currency" | "date" | "datetime" | "boolean" | "email" | "url" | "percentage") | null;
                        /** Format: uuid */
                        id?: string;
                        /** @default true */
                        isVisible?: boolean;
                        label: string;
                        /** Format: uuid */
                        reportId?: string;
                        width?: number | null;
                    }[];
                    config?: {
                        [key: string]: unknown;
                    } | null;
                    description?: string | null;
                    /** @default [] */
                    filters?: {
                        displayOrder: number;
                        fieldPath: string;
                        /** Format: uuid */
                        id?: string;
                        /** @enum {string} */
                        operator: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "like" | "not_like" | "in" | "not_in" | "is_null" | "is_not_null" | "starts_with" | "ends_with" | "between";
                        /** Format: uuid */
                        reportId?: string;
                        value?: string | null;
                        value2?: string | null;
                    }[];
                    /** Format: uuid */
                    id?: string;
                    /** @default false */
                    isPublic?: boolean;
                    itemType?: string;
                    name?: string;
                    sharedWithRoles?: string[] | null;
                    sharedWithUsers?: string[] | null;
                    /** @default [] */
                    sorts?: {
                        /** @enum {string} */
                        direction: "asc" | "desc";
                        fieldPath: string;
                        /** Format: uuid */
                        id?: string;
                        priority: number;
                        /** Format: uuid */
                        reportId?: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ReportsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ReportsByIdExecute: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default 100 */
                    limit?: number;
                    /** @default 0 */
                    offset?: number;
                    runtimeFilters?: {
                        fieldPath: string;
                        /** @enum {string} */
                        operator: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "like" | "not_like" | "in" | "not_in" | "is_null" | "is_not_null" | "starts_with" | "ends_with" | "between";
                        value?: string;
                        value2?: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ReportsByIdExport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default 100 */
                    limit?: number;
                    /** @default 0 */
                    offset?: number;
                    runtimeFilters?: {
                        fieldPath: string;
                        /** @enum {string} */
                        operator: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "like" | "not_like" | "in" | "not_in" | "is_null" | "is_not_null" | "starts_with" | "ends_with" | "between";
                        value?: string;
                        value2?: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1RequirementsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1RequirementsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    acceptanceCriteria?: string;
                    commitMessage?: string;
                    description?: string;
                    name?: string;
                    /** @enum {string} */
                    priority?: "low" | "medium" | "high" | "critical";
                    requirementType?: string;
                    state?: string;
                    type?: string;
                    /** @enum {string} */
                    verificationMethod?: "inspection" | "analysis" | "demonstration" | "test" | "documentation";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1RequirementsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1RequirementsByIdAllocate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            items: {
                                /** Format: uuid */
                                id: string;
                                itemNumber: string;
                                itemType: string;
                                name: string | null;
                                /** Format: uuid */
                                relationshipId: string;
                                revision: string;
                                state: string;
                            }[];
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1RequirementsByIdAllocate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    itemIds: string[];
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            success: boolean;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1RequirementsByIdAllocate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    /** Format: uuid */
                    itemId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            success: boolean;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1RequirementsByIdDerive: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1RequirementsByIdDerive: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    acceptanceCriteria?: string;
                    /** Format: uuid */
                    branchId?: string;
                    category?: string;
                    commitMessage?: string;
                    description?: string;
                    name: string;
                    /** @enum {string} */
                    priority?: "MustHave" | "ShouldHave" | "CouldHave" | "WontHave";
                    source?: string;
                    /** @enum {string} */
                    type?: "Functional" | "Non-Functional" | "Performance" | "Security" | "Usability" | "Business";
                    /** @enum {string} */
                    verificationMethod?: "Analysis" | "Inspection" | "Demonstration" | "Test" | "Documentation";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1RequirementsByIdParent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1RequirementsByIdSatisfy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1RequirementsByIdSatisfy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    itemIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1RequirementsByIdSatisfy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    /** Format: uuid */
                    itemId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1RequirementsByIdVerify: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    branchId?: string;
                    testCaseIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1RequirementsByIdVerify: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1RequirementsByIdVerifyingTests: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Roles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SetupComplete: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SetupProgress: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    ai: boolean;
                    dismissedAt: string | null;
                    orgInfo: boolean;
                    programs: boolean;
                    /** @default false */
                    tools?: boolean;
                    users: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SetupSeedCatalog: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SetupSkip: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SetupStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SoftwareById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1SoftwareById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    attributes?: {
                        [key: string]: unknown;
                    };
                    buildArtifactFileId?: string | null;
                    commitMessage?: string;
                    description?: string | null;
                    name?: string | null;
                    softwareType?: ("firmware" | "application" | "library" | "configuration" | "fpga") | null;
                    /** @enum {string} */
                    sourceMode?: "internal" | "external";
                    state?: string;
                    targetHardware?: string | null;
                    toolchain?: string | null;
                    version?: string | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1SoftwareById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SoftwareByIdBlobByHash: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                hash: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SoftwareByIdCommit: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    message: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SoftwareByIdDiff: {
        parameters: {
            query: {
                fromItemId: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SoftwareByIdDraftDiscard: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SoftwareByIdFile: {
        parameters: {
            query: {
                branchId?: string;
                commitId?: string;
                tagId?: string;
                path: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1SoftwareByIdFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content: string;
                    /** @enum {string} */
                    encoding?: "utf8" | "base64";
                    path: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1SoftwareByIdFile: {
        parameters: {
            query: {
                path: string;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SoftwareByIdFileRename: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    fromPath: string;
                    toPath: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SoftwareByIdFiles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SoftwareByIdTree: {
        parameters: {
            query?: {
                branchId?: string;
                commitId?: string;
                tagId?: string;
                draft?: "true" | "false";
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            draftManifestId: string | null;
                            entries: {
                                hash: string;
                                path: string;
                                size: number;
                            }[];
                            fileCount: number;
                            isDraft: boolean;
                            itemId: string;
                            manifestId: string | null;
                            revision: string;
                            totalSize: number;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SoftwareByIdVersions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SysmlProjects: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SysmlProjectsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1SysmlProjectsByIdBranchesByBidElements: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                bid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    "@id": string;
                    "@type": string;
                } & {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SysmlProjectsByIdCommits: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1SysmlProjectsByIdCommitsByCidElements: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                cid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1TagsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1TagsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1TasksById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1TasksById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    assignee?: string;
                    commitMessage?: string;
                    description?: string;
                    /** Format: date-time */
                    dueDate?: string;
                    name?: string;
                    /** @enum {string} */
                    priority?: "low" | "medium" | "high" | "critical";
                    state?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1TasksById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1TestCasesByIdExecute: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    actualResults?: string;
                    duration?: number;
                    environment?: string;
                    notes?: string;
                    /** @enum {string} */
                    status: "Passed" | "Failed" | "Blocked";
                };
            };
        };
        responses: {
            /** @description Success */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            execution: {
                                actualResults: string | null;
                                duration: number | null;
                                environment: string | null;
                                /** Format: date-time */
                                executedAt: string;
                                /** Format: uuid */
                                executorId: string;
                                executorName: string;
                                /** Format: uuid */
                                id: string;
                                notes: string | null;
                                status: string;
                                /** Format: uuid */
                                testCaseId: string;
                            };
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1TestCasesByIdExecutions: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            executions: {
                                actualResults: string | null;
                                duration: number | null;
                                environment: string | null;
                                /** Format: date-time */
                                executedAt: string;
                                /** Format: uuid */
                                executorId: string;
                                executorName: string;
                                /** Format: uuid */
                                id: string;
                                notes: string | null;
                                status: string;
                                /** Format: uuid */
                                testCaseId: string;
                            }[];
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1TestPlansByIdTestCases: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            testCases: {
                                executionStatus: string | null;
                                /** Format: uuid */
                                id: string;
                                itemNumber: string;
                                lastExecutedAt: string | null;
                                name: string | null;
                                state: string;
                                testType: string | null;
                            }[];
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ThreadByItemId: {
        parameters: {
            query?: {
                domains?: string;
                upstreamDepth?: number;
                downstreamDepth?: number;
                bomDepth?: number;
                physicalDepth?: number;
            };
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1ThreadByItemIdCompare: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    afterContext: {
                        /** Format: uuid */
                        designId: string;
                        /** @constant */
                        type: "released";
                    } | {
                        /** Format: uuid */
                        branchId: string;
                        /** @constant */
                        type: "branch";
                    } | {
                        /** Format: uuid */
                        commitId: string;
                        /** @constant */
                        type: "commit";
                    } | {
                        /** Format: uuid */
                        tagId: string;
                        /** @constant */
                        type: "tag";
                    };
                    beforeContext: {
                        /** Format: uuid */
                        designId: string;
                        /** @constant */
                        type: "released";
                    } | {
                        /** Format: uuid */
                        branchId: string;
                        /** @constant */
                        type: "branch";
                    } | {
                        /** Format: uuid */
                        commitId: string;
                        /** @constant */
                        type: "commit";
                    } | {
                        /** Format: uuid */
                        tagId: string;
                        /** @constant */
                        type: "tag";
                    };
                    /** @default 3 */
                    bomDepth?: number;
                    /**
                     * @default [
                     *       "requirements",
                     *       "engineering",
                     *       "manufacturing",
                     *       "validation"
                     *     ]
                     */
                    domains?: ("requirements" | "engineering" | "manufacturing" | "validation" | "physical")[];
                    /** @default 5 */
                    downstreamDepth?: number;
                    /** @default true */
                    includeFieldChanges?: boolean;
                    /** @default 5 */
                    upstreamDepth?: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ThreadByItemIdComparisonTargets: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1ToolsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1ToolsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    attributes?: {
                        [key: string]: unknown;
                    };
                    capabilities?: {
                        [key: string]: unknown;
                    } | null;
                    commitMessage?: string;
                    location?: string | null;
                    manufacturer?: string | null;
                    model?: string | null;
                    name?: string | null;
                    notes?: string | null;
                    state?: string;
                    toolSubtype?: string | null;
                    toolType?: string | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1ToolsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Users: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1Users: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default true */
                    active?: boolean;
                    /** Format: email */
                    email: string;
                    name: string;
                    password: string;
                    /**
                     * @default local
                     * @enum {string}
                     */
                    provider?: "local" | "azure" | "google" | "github";
                    providerId?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1UsersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1UsersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Not accepted here. Account status is changed with POST /users/:id/activate, which revokes the sessions of an account it deactivates and is gated on users:manage. */
                    active?: unknown;
                    /** Format: email */
                    email?: string;
                    name?: string;
                    /** @enum {string} */
                    provider?: "local" | "azure" | "google" | "github";
                    providerId?: string | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1UsersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1UsersByIdActivate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    active: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1UsersByIdPassword: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    currentPassword: string;
                    password: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1UsersByIdResetPassword: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    password: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1UsersByIdRoles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1UsersByIdRoles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    roleIds: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkInstructionsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkInstructionsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    attributes?: {
                        [key: string]: unknown;
                    };
                    commitMessage?: string;
                    description?: string | null;
                    difficulty?: ("Easy" | "Medium" | "Hard") | null;
                    estimatedTime?: number | null;
                    name?: string | null;
                    requiredTools?: string | null;
                    safetyNotes?: string | null;
                    state?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkInstructionsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkInstructionsByIdAlerts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkInstructionsByIdAlerts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action: "acknowledge" | "dismiss";
                    /** Format: uuid */
                    alertId: string;
                    notes?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkInstructionsByIdAlerts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkInstructionsByIdOperations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkInstructionsByIdOperations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    operations: {
                        /** Format: uuid */
                        id: string;
                        orderIndex: number;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkInstructionsByIdOperations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    estimatedTime?: number | null;
                    title: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkInstructionsByIdOperationsByOperationId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                operationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    estimatedTime?: number | null;
                    title?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkInstructionsByIdOperationsByOperationId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                operationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkInstructionsByIdParts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkInstructionsByIdParts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    inheritToMBOM?: boolean;
                    /** Format: uuid */
                    partId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkInstructionsByIdParts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    partId?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1WorkInstructionsByIdParts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    inheritToMBOM?: boolean;
                    isOutput?: boolean;
                    /** Format: uuid */
                    partId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkInstructionsByIdResolveParametric: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkInstructionsByIdSteps: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkInstructionsByIdSteps: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    steps: {
                        /** Format: uuid */
                        id: string;
                        orderIndex: number;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkInstructionsByIdSteps: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content?: {
                        /** @default [] */
                        blocks?: {
                            alt?: string;
                            attributePath?: string;
                            caption?: string;
                            content?: string;
                            fallbackValue?: string;
                            fieldLabel?: string;
                            fieldRequired?: boolean;
                            /** @enum {string} */
                            fieldType?: "text" | "numeric" | "checkbox" | "passFail";
                            fieldValidation?: {
                                max?: number;
                                min?: number;
                                pattern?: string;
                            };
                            /** Format: uuid */
                            fileId?: string;
                            id: string;
                            label?: string;
                            /** Format: uuid */
                            partId?: string;
                            /** @enum {string} */
                            type: "text" | "image" | "parametric" | "dataField";
                            unit?: string;
                        }[];
                    };
                    orderIndex?: number;
                    title?: string | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkInstructionsByIdStepsByStepId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stepId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkInstructionsByIdStepsByStepId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stepId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content?: {
                        /** @default [] */
                        blocks?: {
                            alt?: string;
                            attributePath?: string;
                            caption?: string;
                            content?: string;
                            fallbackValue?: string;
                            fieldLabel?: string;
                            fieldRequired?: boolean;
                            /** @enum {string} */
                            fieldType?: "text" | "numeric" | "checkbox" | "passFail";
                            fieldValidation?: {
                                max?: number;
                                min?: number;
                                pattern?: string;
                            };
                            /** Format: uuid */
                            fileId?: string;
                            id: string;
                            label?: string;
                            /** Format: uuid */
                            partId?: string;
                            /** @enum {string} */
                            type: "text" | "image" | "parametric" | "dataField";
                            unit?: string;
                        }[];
                    };
                    operationId?: string | null;
                    orderIndex?: number;
                    title?: string | null;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkInstructionsByIdStepsByStepId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stepId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkInstructionsByIdUsage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default [] */
                    assignedTo?: string[];
                    customerOrder?: string | null;
                    dueDate?: string | null;
                    notes?: string | null;
                    partId?: string | null;
                    /**
                     * @default Normal
                     * @enum {string}
                     */
                    priority?: "Low" | "Normal" | "High" | "Urgent";
                    programId?: string | null;
                    /** @default 1 */
                    quantity?: number;
                    /** @default false */
                    requiresSignOff?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkOrdersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    assignedTo?: string[];
                    customerOrder?: string | null;
                    dueDate?: string | null;
                    notes?: string | null;
                    partId?: string | null;
                    /** @enum {string} */
                    priority?: "Low" | "Normal" | "High" | "Urgent";
                    programId?: string | null;
                    quantity?: number;
                    quantityCompleted?: number;
                    requiresSignOff?: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkOrdersById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdExecutions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdExecutionsByExecutionId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkOrdersByIdExecutionsByExecutionId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    currentStepIndex?: number;
                    stepData?: {
                        blockId: string;
                        value: unknown;
                    };
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdExecutionsByExecutionIdAbandon: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    notes?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdExecutionsByExecutionIdComplete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    notes?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdExecutionsByExecutionIdResubmit: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdExecutionsByExecutionIdSignOff: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdExecutionsByExecutionIdSignOff: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comments?: string;
                    /** @enum {string} */
                    decision: "approved" | "rejected";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdInstructions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkOrdersByIdInstructions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    instructions: {
                        /** Format: uuid */
                        id: string;
                        orderIndex: number;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdInstructions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    partId?: string | null;
                    perUnit?: boolean;
                    requiredCount?: number;
                    /** Format: uuid */
                    workInstructionId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdInstructionsPopulate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdInstructionsByInstructionId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkOrdersByIdInstructionsByInstructionId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1WorkOrdersByIdInstructionsByInstructionId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    requiredCount: number;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdInstructionsByInstructionIdExecutions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdInstructionsByInstructionIdExecutions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    unitLabel?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdInstructionsByInstructionIdRefresh: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdInstructionsByInstructionIdResolveParametric: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdInstructionsByInstructionIdSkip: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdInstructionsByInstructionIdUnskip: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                instructionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdMaterials: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdMaterials: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    lotNumber?: string;
                    notes?: string;
                    /** Format: uuid */
                    partMasterId: string;
                    quantity?: number;
                    serialNumber?: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkOrdersByIdMaterialsByEdgeId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                edgeId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkOrdersByIdProduce: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    serialNumbers: string[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdProduced: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkOrdersByIdQualification: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkOrdersByIdStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    status: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Workflows: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1Workflows: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    applicableItemTypes?: string[];
                    changeActionMappings?: {
                        obsolete?: {
                            assignsRevision: boolean;
                            fromState: string;
                            toState: string;
                        };
                        promote?: {
                            assignsRevision: boolean;
                            fromState: string;
                            resetRevision?: boolean;
                            toState: string;
                        };
                        release?: {
                            assignsRevision: boolean;
                            fromState: string;
                            toState: string;
                        };
                        revise?: {
                            /** @constant */
                            assignsRevision: true;
                            fromState: string;
                            newVersionState: string;
                            oldVersionState: string;
                        };
                    };
                    description?: string;
                    drivers?: string[];
                    isActive?: boolean;
                    /** @enum {string} */
                    lifecycleType?: "Free" | "Driven" | "Driving";
                    name: string;
                    phases?: {
                        color?: string;
                        id: string;
                        name: string;
                        order: number;
                        resetRevisionOnEntry?: boolean;
                        revisionScheme?: {
                            /** @constant */
                            type: "alpha";
                            uppercase?: boolean;
                        } | {
                            /** @constant */
                            type: "numeric";
                        } | {
                            prefix: string;
                            /** @constant */
                            type: "prefixed-numeric";
                        } | {
                            /** @constant */
                            type: "none";
                        };
                    }[];
                    revisionScheme?: {
                        /** @constant */
                        type: "alpha";
                        uppercase?: boolean;
                    } | {
                        /** @constant */
                        type: "numeric";
                    } | {
                        prefix: string;
                        /** @constant */
                        type: "prefixed-numeric";
                    } | {
                        /** @constant */
                        type: "none";
                    };
                    states?: {
                        color?: string;
                        description?: string;
                        /** @enum {string} */
                        finalKind?: "release" | "cancel" | "complete";
                        id: string;
                        instructions?: string;
                        isFinal?: boolean;
                        isInitial?: boolean;
                        name: string;
                        phaseId?: string;
                        position?: {
                            x: number;
                            y: number;
                        };
                    }[];
                    transitions?: {
                        actions?: ({
                            config: {
                                recipients: {
                                    id: string;
                                    /** @enum {string} */
                                    type: "user" | "role";
                                }[];
                                /** @constant */
                                templateId: "workflow_transition";
                            };
                            /** @enum {string} */
                            executeOn: "before" | "after";
                            id: string;
                            name: string;
                            /** @constant */
                            type: "send_notification";
                        } | {
                            config: {
                                fieldName: string;
                                value: string | number | boolean;
                            };
                            /** @enum {string} */
                            executeOn: "before" | "after";
                            id: string;
                            name: string;
                            /** @constant */
                            type: "update_field";
                        })[];
                        approvalRequirement?: {
                            requiredCount: number;
                        };
                        description?: string;
                        fromStateId: string;
                        guards?: ({
                            config: {
                                fieldName: string;
                                /** @enum {string} */
                                operator: "equals" | "not_equals" | "contains" | "is_empty" | "is_not_empty" | "greater_than" | "less_than" | "greater_or_equal" | "less_or_equal";
                                value?: string | number | boolean;
                            };
                            errorMessage?: string;
                            id: string;
                            name: string;
                            /** @constant */
                            type: "field_value";
                        } | {
                            config: {
                                requireAll?: boolean;
                                requiredRoles: string[];
                            };
                            errorMessage?: string;
                            id: string;
                            name: string;
                            /** @constant */
                            type: "user_role";
                        })[];
                        id: string;
                        labelPosition?: {
                            x: number;
                            y: number;
                        };
                        name: string;
                        toStateId: string;
                    }[];
                    /** @enum {string} */
                    workflowType?: "strict" | "flexible";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkflowsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkflowsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    applicableItemTypes?: string[];
                    changeActionMappings?: {
                        obsolete?: {
                            assignsRevision: boolean;
                            fromState: string;
                            toState: string;
                        };
                        promote?: {
                            assignsRevision: boolean;
                            fromState: string;
                            resetRevision?: boolean;
                            toState: string;
                        };
                        release?: {
                            assignsRevision: boolean;
                            fromState: string;
                            toState: string;
                        };
                        revise?: {
                            /** @constant */
                            assignsRevision: true;
                            fromState: string;
                            newVersionState: string;
                            oldVersionState: string;
                        };
                    };
                    description?: string;
                    drivers?: string[];
                    isActive?: boolean;
                    /** @enum {string} */
                    lifecycleType?: "Free" | "Driven" | "Driving";
                    name?: string;
                    phases?: {
                        color?: string;
                        id: string;
                        name: string;
                        order: number;
                        resetRevisionOnEntry?: boolean;
                        revisionScheme?: {
                            /** @constant */
                            type: "alpha";
                            uppercase?: boolean;
                        } | {
                            /** @constant */
                            type: "numeric";
                        } | {
                            prefix: string;
                            /** @constant */
                            type: "prefixed-numeric";
                        } | {
                            /** @constant */
                            type: "none";
                        };
                    }[];
                    revisionScheme?: {
                        /** @constant */
                        type: "alpha";
                        uppercase?: boolean;
                    } | {
                        /** @constant */
                        type: "numeric";
                    } | {
                        prefix: string;
                        /** @constant */
                        type: "prefixed-numeric";
                    } | {
                        /** @constant */
                        type: "none";
                    };
                    states?: {
                        color?: string;
                        description?: string;
                        /** @enum {string} */
                        finalKind?: "release" | "cancel" | "complete";
                        id: string;
                        instructions?: string;
                        isFinal?: boolean;
                        isInitial?: boolean;
                        name: string;
                        phaseId?: string;
                        position?: {
                            x: number;
                            y: number;
                        };
                    }[];
                    transitions?: {
                        actions?: ({
                            config: {
                                recipients: {
                                    id: string;
                                    /** @enum {string} */
                                    type: "user" | "role";
                                }[];
                                /** @constant */
                                templateId: "workflow_transition";
                            };
                            /** @enum {string} */
                            executeOn: "before" | "after";
                            id: string;
                            name: string;
                            /** @constant */
                            type: "send_notification";
                        } | {
                            config: {
                                fieldName: string;
                                value: string | number | boolean;
                            };
                            /** @enum {string} */
                            executeOn: "before" | "after";
                            id: string;
                            name: string;
                            /** @constant */
                            type: "update_field";
                        })[];
                        approvalRequirement?: {
                            requiredCount: number;
                        };
                        description?: string;
                        fromStateId: string;
                        guards?: ({
                            config: {
                                fieldName: string;
                                /** @enum {string} */
                                operator: "equals" | "not_equals" | "contains" | "is_empty" | "is_not_empty" | "greater_than" | "less_than" | "greater_or_equal" | "less_or_equal";
                                value?: string | number | boolean;
                            };
                            errorMessage?: string;
                            id: string;
                            name: string;
                            /** @constant */
                            type: "field_value";
                        } | {
                            config: {
                                requireAll?: boolean;
                                requiredRoles: string[];
                            };
                            errorMessage?: string;
                            id: string;
                            name: string;
                            /** @constant */
                            type: "user_role";
                        })[];
                        id: string;
                        labelPosition?: {
                            x: number;
                            y: number;
                        };
                        name: string;
                        toStateId: string;
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkflowsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkflowsByIdApprovers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkflowsByIdStatesByStateIdApprovers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    putApiV1WorkflowsByIdStatesByStateIdApprovers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    approvers: {
                        /** Format: uuid */
                        id: string;
                        /** @default true */
                        isRequired?: boolean;
                        /** @enum {string} */
                        type: "user" | "role";
                    }[];
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkflowsByIdStatesByStateIdApprovers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    id: string;
                    /** @default true */
                    isRequired?: boolean;
                    /** @enum {string} */
                    type: "user" | "role";
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkflowsByIdStatesByStateIdApproversByApproverId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
                approverId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    patchApiV1WorkflowsByIdStatesByStateIdApproversByApproverId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                stateId: string;
                approverId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    isRequired: boolean;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkflowsByIdValidate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1Workspaces: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1Workspaces: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    designId: string;
                    workspaceName: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkspacesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        data: {
                            baseCommitId: string | null;
                            createdAt: string;
                            designCode: string;
                            /** Format: uuid */
                            designId: string;
                            designName: string;
                            headCommitId: string | null;
                            /** Format: uuid */
                            id: string;
                            isArchived: boolean | null;
                            isLocked: boolean | null;
                            itemCount: number;
                            name: string;
                            ownerId: string | null;
                            workspaceOnlyItemCount: number;
                        };
                    };
                };
            };
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkspacesById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkspacesByIdConvertToEco: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @default ECO
                     * @enum {string}
                     */
                    changeType?: "ECO" | "ECN" | "Deviation" | "MCO" | "XCO";
                    /** @default false */
                    deleteWorkspace?: boolean;
                    ecoDescription?: string;
                    ecoTitle: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    getApiV1WorkspacesByIdItems: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    deleteApiV1WorkspacesByIdItemsByMasterId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                masterId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
    postApiV1WorkspacesByIdMergeToEco: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default false */
                    deleteWorkspace?: boolean;
                    /** Format: uuid */
                    ecoId: string;
                };
            };
        };
        responses: {
            400: components["responses"]["ValidationError"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["ServerError"];
        };
    };
}
