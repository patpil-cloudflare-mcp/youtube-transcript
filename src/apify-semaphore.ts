/**
 * Apify Semaphore - Durable Object for Concurrency Control
 *
 * CRITICAL: This Durable Object enforces the 32-concurrent-run limit
 * for Apify Actor executions (Starter plan constraint).
 *
 * Purpose:
 * - Prevents the 33rd+ request from attempting to run an Actor
 * - Implements "Fast Fail" pattern: immediately returns 429 when full
 * - Tracks active slots and provides status monitoring
 * - Auto-cleans stale slots (>5 minutes old)
 *
 * Flow:
 * 1. Tool attempts to acquire slot before calling Apify API
 * 2. If acquired (< 32 active): Proceed with API call
 * 3. If full (= 32 active): Return 429 with estimated wait time
 * 4. Tool ALWAYS releases slot in finally block after completion
 *
 * Global Singleton: Use idFromName("global-apify-limiter") for single instance
 *
 * @see /Users/patpil/cloudflare_mcp_projects/cloudflare_mcp_apify/apify_docs.md
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, SemaphoreSlot } from "./types";

export class ApifySemaphore extends DurableObject<Env> {
    /**
     * Number of currently active Apify Actor runs
     * Persisted to storage for durability across restarts
     */
    private activeSlots: number = 0;

    /**
     * Maximum concurrent Apify runs allowed
     * Based on Apify Starter plan limit (32 concurrent runs)
     */
    private readonly MAX_SLOTS = 32;

    /**
     * Registry tracking individual slot allocations
     * Key: slotId (userId-timestamp), Value: slot metadata
     */
    private slotRegistry: Map<string, {
        userId: string;
        actorId: string;
        timestamp: number;
    }> = new Map();

    /**
     * Initialize Durable Object and restore state from storage
     */
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        // CRITICAL: Restore active slot count from persistent storage
        // This ensures state survives Durable Object restarts
        this.ctx.blockConcurrencyWhile(async () => {
            const stored = await this.ctx.storage.get<number>("activeSlots");
            this.activeSlots = stored || 0;

            console.log(`[ApifySemaphore] Initialized with ${this.activeSlots}/${this.MAX_SLOTS} active slots`);

            // Restore slot registry if it exists
            const storedRegistry = await this.ctx.storage.get<Array<[string, any]>>("slotRegistry");
            if (storedRegistry) {
                this.slotRegistry = new Map(storedRegistry);
            }
        });
    }

    /**
     * Attempt to acquire a slot for Apify Actor execution
     *
     * CRITICAL: This is the gate that implements the Fast Fail pattern.
     * If no slots available, returns { acquired: false } immediately.
     *
     * @param userId - User ID making the request
     * @param actorId - Apify Actor ID to be executed
     * @returns Slot acquisition result with status and metadata
     */
    async acquireSlot(userId: string, actorId: string): Promise<SemaphoreSlot> {
        // CRITICAL CHECK: Fast Fail if at capacity
        if (this.activeSlots >= this.MAX_SLOTS) {
            console.warn(
                `[ApifySemaphore] FULL: ${this.activeSlots}/${this.MAX_SLOTS} slots used. ` +
                `Rejecting request from user ${userId} for actor ${actorId}`
            );

            return {
                acquired: false,
                currentSlots: this.activeSlots,
                maxSlots: this.MAX_SLOTS,
                estimatedWaitTime: 60  // Average Actor runtime estimate
            };
        }

        // Acquire slot
        this.activeSlots++;
        const slotId = `${userId}-${Date.now()}`;

        this.slotRegistry.set(slotId, {
            userId,
            actorId,
            timestamp: Date.now()
        });

        // Persist to storage for durability
        await this.ctx.storage.put("activeSlots", this.activeSlots);
        await this.ctx.storage.put("slotRegistry", Array.from(this.slotRegistry.entries()));

        console.log(
            `[ApifySemaphore] ACQUIRED: ${this.activeSlots}/${this.MAX_SLOTS} slots used. ` +
            `User ${userId}, Actor ${actorId}, Slot ${slotId}`
        );

        return {
            acquired: true,
            currentSlots: this.activeSlots,
            maxSlots: this.MAX_SLOTS
        };
    }

    /**
     * Release a slot after Apify Actor execution completes
     *
     * CRITICAL: ALWAYS call this in a finally block to ensure slots are released
     * even if the Actor execution fails.
     *
     * @param userId - User ID who acquired the slot
     */
    async releaseSlot(userId: string): Promise<void> {
        // Find and remove user's most recent slot
        let releasedSlotId: string | null = null;

        for (const [slotId, slot] of this.slotRegistry.entries()) {
            if (slot.userId === userId) {
                this.slotRegistry.delete(slotId);
                releasedSlotId = slotId;
                break;  // Release only one slot per call
            }
        }

        if (releasedSlotId) {
            this.activeSlots = Math.max(0, this.activeSlots - 1);

            // Persist updated state
            await this.ctx.storage.put("activeSlots", this.activeSlots);
            await this.ctx.storage.put("slotRegistry", Array.from(this.slotRegistry.entries()));

            console.log(
                `[ApifySemaphore] RELEASED: ${this.activeSlots}/${this.MAX_SLOTS} slots used. ` +
                `Slot ${releasedSlotId}`
            );
        } else {
            console.warn(
                `[ApifySemaphore] RELEASE FAILED: No active slot found for user ${userId}`
            );
        }
    }

    /**
     * Get current semaphore status (for monitoring/debugging)
     *
     * @returns Current slot utilization statistics
     */
    async getStatus(): Promise<{
        active: number;
        max: number;
        available: number;
        slots: Array<{ userId: string; actorId: string; ageSeconds: number }>;
    }> {
        const now = Date.now();
        const slots = Array.from(this.slotRegistry.values()).map(slot => ({
            userId: slot.userId,
            actorId: slot.actorId,
            ageSeconds: Math.floor((now - slot.timestamp) / 1000)
        }));

        return {
            active: this.activeSlots,
            max: this.MAX_SLOTS,
            available: this.MAX_SLOTS - this.activeSlots,
            slots
        };
    }

    /**
     * Cleanup stale slots (>5 minutes old)
     *
     * IMPORTANT: This handles cases where releaseSlot() wasn't called
     * (e.g., due to Worker crashes, timeouts, or bugs).
     *
     * Call this periodically (e.g., via Cron trigger) or on-demand.
     *
     * @returns Number of stale slots cleaned up
     */
    async cleanupStaleSlots(): Promise<number> {
        const now = Date.now();
        const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
        let cleaned = 0;

        for (const [slotId, slot] of this.slotRegistry.entries()) {
            const age = now - slot.timestamp;
            if (age > STALE_THRESHOLD) {
                this.slotRegistry.delete(slotId);
                this.activeSlots = Math.max(0, this.activeSlots - 1);
                cleaned++;

                console.warn(
                    `[ApifySemaphore] CLEANUP: Removed stale slot ${slotId} ` +
                    `(age: ${Math.floor(age / 1000)}s, user: ${slot.userId}, actor: ${slot.actorId})`
                );
            }
        }

        if (cleaned > 0) {
            // Persist updated state
            await this.ctx.storage.put("activeSlots", this.activeSlots);
            await this.ctx.storage.put("slotRegistry", Array.from(this.slotRegistry.entries()));

            console.log(
                `[ApifySemaphore] CLEANUP COMPLETE: Removed ${cleaned} stale slots. ` +
                `Current: ${this.activeSlots}/${this.MAX_SLOTS}`
            );
        }

        return cleaned;
    }

    /**
     * RPC method handler (optional, for debugging via Service Bindings)
     *
     * Example usage from Worker:
     *   const semaphore = env.APIFY_SEMAPHORE.get(id);
     *   const status = await semaphore.getStatus();
     */
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        switch (url.pathname) {
            case "/status":
                const status = await this.getStatus();
                return Response.json(status);

            case "/cleanup":
                const cleaned = await this.cleanupStaleSlots();
                return Response.json({ cleaned, ...await this.getStatus() });

            default:
                return new Response("Not Found", { status: 404 });
        }
    }
}
